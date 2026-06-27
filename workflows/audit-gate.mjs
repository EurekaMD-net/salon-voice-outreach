/**
 * audit-gate — multi-dimension parallel code audit (Claude Code Workflow script).
 *
 * The fan-out replacement for a single sequential qa-auditor pass: N reviewers each
 * audit the diff through ONE lens concurrently, findings are deduped across lenses,
 * each surviving finding is adversarially refuted before it reaches you, then the
 * result is ranked. A finding only ships if it survives a skeptic trying to kill it.
 *
 * Runtime: this runs inside the Claude Code Workflow runtime — `agent`, `parallel`,
 * `phase`, `log`, `args`, `budget` are runtime globals, NOT Node. It is plain ESM
 * (no TypeScript). Do not `node` it directly; invoke via the Workflow tool:
 *
 *   Workflow({
 *     scriptPath: "/root/claude/projects/salon-voice-outreach/workflows/audit-gate.mjs",
 *     args: { target: "git diff origin/main...HEAD", paths: ["orchestrator/src"] }
 *   })
 *
 * args (all optional):
 *   target  — how reviewers should establish the diff (default: working tree + last commit)
 *   paths   — array of paths to scope the audit to (default: all changed files)
 *   context — extra project context to hand every reviewer
 */

export const meta = {
  name: 'audit-gate',
  description:
    'Multi-dimension parallel code audit: 5 lenses (correctness, security, contract-drift, test-coverage, scope/convention) review the diff concurrently, dedup across lenses, adversarially refute each finding, then rank. The fan-out replacement for one qa-auditor pass.',
  phases: [
    { title: 'Review', detail: 'one reviewer per dimension, concurrent' },
    { title: 'Verify', detail: 'adversarial refute pass per deduped finding' },
    { title: 'Synthesize', detail: 'dedup, rank, report' },
  ],
}

// ---- scope (from args, with safe defaults) ----
const a = args || {}
const target =
  a.target ||
  'the changes in THIS repo. Establish the diff yourself: run `git diff origin/main...HEAD` for committed work plus `git status --porcelain` and `git diff` for uncommitted work. If origin/main is unavailable, fall back to `git diff HEAD~1`.'
const paths = a.paths && a.paths.length ? a.paths.join(', ') : 'every changed file'
const extraContext = a.context ? `\n\nExtra project context:\n${a.context}` : ''

// Conventions every reviewer judges against (salon-voice-outreach / very-light methodology).
const CONVENTIONS = `Project conventions to judge against:
- very-light methodology: Hono + better-sqlite3, ESM/NodeNext, strict tsc, heavy tests, minimal deps.
- Fail CLOSED: validators throw on bad input, never silently widen/default. SQLite NOT NULL still permits '' — treat empty-string identity as invalid.
- Canonical timestamps: SQL datetime('now') ("YYYY-MM-DD HH:MM:SS"), NEVER JS toISOString() (the 'T' breaks lexical ORDER BY on TEXT).
- Set-once provenance: source/attribution written only on row creation, never rewritten.
- Ports: producers/consumers couple only at a named seam behind an interface + fake.
- Surgical changes: every changed line traces to the task; no unrequested refactors/flexibility.`

const DIMENSIONS = [
  {
    key: 'correctness',
    lens: 'Logic bugs, edge cases, off-by-one, null/undefined derefs, wrong conditionals, error handling, async/await races, transaction boundaries. Trace the ACTUAL control flow, do not assume.',
  },
  {
    key: 'security',
    lens: 'Auth/authz gaps, missing/again-bypassable bearer guards, injection, secret or PII exposure in logs/responses, SSRF, missing input validation, fail-OPEN config defaults, constant-time compare on tokens.',
  },
  {
    key: 'contract-drift',
    lens: 'Producer/consumer seam mismatches: enumerate EVERY shape a producer can emit vs what the consumer accepts, field by field. Poison-pill rows (a producer-emittable value the consumer rejects → permanent retry / head-of-line block). API/wire-contract or enum changes that break an existing caller.',
  },
  {
    key: 'test-coverage',
    lens: 'Tests that encode a WRONG assumption (so they pass on broken code), a missing regression test reproducing the actual failure (not just the unit symptom), untested error/edge/empty paths, and mocks placed at the very seam the bug lives in (hiding it).',
  },
  {
    key: 'scope-convention',
    lens: 'Violations of the project conventions below: fail-open instead of fail-closed, toISOString instead of datetime(), provenance rewritten after creation, out-of-scope edits, unrequested complexity/abstraction, require() instead of import.',
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'title', 'detail', 'suggestedFix'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Info'] },
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line number or range, or "" if file-level' },
          title: { type: 'string', description: 'one-line summary of the defect' },
          detail: { type: 'string', description: 'why it is wrong, citing the code' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'confidence', 'reasoning'],
  properties: {
    isReal: {
      type: 'boolean',
      description: 'true ONLY if it is a genuine defect after a real attempt to refute it',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string', description: 'cite the code you read to reach the verdict' },
  },
}

const reviewPrompt = (d) =>
  `You are a code auditor with ONE lens: ${d.key}.

Scope: audit ${paths} in the current repository. ${target}
Read the changed files and the code immediately around them. Do NOT flag unchanged code unless a change breaks it.

${CONVENTIONS}${extraContext}

Your lens — report ONLY findings of this class: ${d.lens}

Severity: Critical = ships a real bug / security hole / data-loss path; Warning = a real but bounded problem; Info = minor / style. For each finding give file, line, a one-line title, a concrete detail that cites the offending code, and a suggestedFix. Be specific. If your lens finds nothing, return an empty findings array — do NOT invent findings to look thorough.`

// ---------- Phase 1: Review (concurrent, one agent per lens) ----------
phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(reviewPrompt(d), { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  ),
)

// Barrier is justified here: dedup across ALL lenses before the expensive verify pass,
// so the same bug flagged by two lenses is refuted once, not twice.
// Iterate the UNFILTERED reviews so index alignment with DIMENSIONS holds (a null review
// must not shift the dimension labels of later reviews).
const raw = []
reviews.forEach((r, i) => {
  if (!r || !Array.isArray(r.findings)) return
  const dim = DIMENSIONS[i].key
  for (const f of r.findings) raw.push({ ...f, dimension: dim })
})

const keyOf = (f) =>
  `${(f.file || '').trim()}::${(f.line || '').trim()}::${(f.title || '').trim().toLowerCase().slice(0, 60)}`
const merged = new Map()
for (const f of raw) {
  const k = keyOf(f)
  if (!merged.has(k)) merged.set(k, { ...f, dimensions: [f.dimension] })
  else if (!merged.get(k).dimensions.includes(f.dimension)) merged.get(k).dimensions.push(f.dimension)
}
const deduped = [...merged.values()]
log(`${raw.length} raw findings across ${reviews.filter(Boolean).length}/${DIMENSIONS.length} lenses → ${deduped.length} after dedup`)

if (deduped.length === 0) {
  return { verdict: 'clean', counts: { raw: 0, deduped: 0, confirmed: 0, dropped: 0 }, bySeverity: { Critical: [], Warning: [], Info: [] }, dropped: [] }
}

// ---------- Phase 2: Verify (adversarial refute; Critical => 3-skeptic majority) ----------
phase('Verify')
const verified = await parallel(
  deduped.map((f) => () => {
    const n = f.severity === 'Critical' ? 3 : 1
    const refute = (i) =>
      agent(
        `Adversarially REFUTE this ${f.severity} finding. Default to isReal=false unless you can PROVE it is a genuine defect by reading the actual code.

Finding (lens: ${f.dimensions.join(', ')}): ${f.title}
Location: ${f.file}:${f.line}
Claim: ${f.detail}

Read the cited code and its surrounding context. Decide: is this REAL, or a false positive — the code already handles it, it is out of scope, the reviewer misread the flow, or it is intended behavior? ${i > 0 ? 'You are an independent skeptic; reason from the code yourself, not from the other skeptics.' : ''}`,
        { label: `verify:${f.file || f.dimensions.join('+')}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      )
    return parallel(Array.from({ length: n }, (_, i) => () => refute(i))).then((votes) => {
      const live = votes.filter(Boolean)
      const real = live.filter((v) => v.isReal).length
      // Fail CLOSED: if NO skeptic ran (all refuters errored), the finding is INCONCLUSIVE,
      // not refuted — KEEP it (flagged) so an infra outage can never silently erase a real
      // finding. Only a finding a live skeptic actually voted down is dropped.
      const verifierFailed = live.length === 0
      const survives = verifierFailed || real >= Math.ceil(n / 2)
      return { ...f, verdict: { real, of: n, survives, verifierFailed, votes: live } }
    })
  }),
)

const ok = verified.filter(Boolean)
const confirmed = ok.filter((f) => f.verdict.survives)
const dropped = ok.filter((f) => !f.verdict.survives)

// ---------- Phase 3: Synthesize (rank) ----------
phase('Synthesize')
const bySeverity = { Critical: [], Warning: [], Info: [] }
for (const f of confirmed) (bySeverity[f.severity] ?? bySeverity.Info).push(f)

const unverified = confirmed.filter((f) => f.verdict.verifierFailed).length
log(`confirmed ${confirmed.length} (C:${bySeverity.Critical.length} W:${bySeverity.Warning.length} I:${bySeverity.Info.length}${unverified ? `, ${unverified} kept UNVERIFIED — refuters errored` : ''}), dropped ${dropped.length} as false-positive`)

return {
  verdict: bySeverity.Critical.length ? 'block' : confirmed.length ? 'review' : 'clean',
  counts: {
    raw: raw.length,
    deduped: deduped.length,
    confirmed: confirmed.length,
    unverified,
    dropped: dropped.length,
    critical: bySeverity.Critical.length,
    warning: bySeverity.Warning.length,
    info: bySeverity.Info.length,
  },
  bySeverity,
  dropped: dropped.map((f) => ({ title: f.title, file: f.file, line: f.line, verdict: f.verdict })),
}
