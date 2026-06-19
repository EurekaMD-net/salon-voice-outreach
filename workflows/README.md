# workflows

Claude Code **Workflow** scripts — deterministic multi-agent orchestrations for this repo.
They run inside the Claude Code Workflow runtime (the `agent` / `parallel` / `phase` / `log`
/ `args` globals), **not** Node directly. They are plain ESM (`.mjs`), not TypeScript, and
sit outside the `orchestrator/` and `vlcrm/` packages (no effect on their builds/tests).

> Running a workflow spawns multiple subagents and **costs tokens** — it is an explicit,
> opt-in action. Authoring/committing one (what lives here) does not.

## `audit-gate.mjs` — multi-dimension parallel code audit

The fan-out replacement for a single sequential `qa-auditor` pass. Five reviewers each
audit the diff through **one lens** — correctness, security, contract-drift, test-coverage,
scope/convention — concurrently. Findings are deduped across lenses, then **each surviving
finding is adversarially refuted** (a skeptic tries to kill it; Critical findings face a
3-skeptic majority) before it reaches you. A finding ships only if it survives the refute.

Why fan-out: a single auditor reads the whole diff through one attention budget and misses
sibling failure modes; five lenses in parallel cover more at the same wall-clock, and the
refute pass strips the plausible-but-wrong findings that a single pass leaves in.

### Invoke

```js
Workflow({
  scriptPath:
    "/root/claude/projects/salon-voice-outreach/workflows/audit-gate.mjs",
  args: {
    target: "git diff origin/main...HEAD", // optional — how reviewers find the diff
    paths: ["vlcrm/src", "orchestrator/src"], // optional — scope
    context: "Increment N: the SMS handoff bridge", // optional — extra context for reviewers
  },
});
```

All `args` are optional; with none, reviewers audit the working tree + last commit across
every changed file.

### Returns

```
{
  verdict:  "block" | "review" | "clean",   // block = a Critical survived
  counts:   { raw, deduped, confirmed, dropped, critical, warning, info },
  bySeverity: { Critical: [...], Warning: [...], Info: [...] },  // confirmed findings
  dropped:  [ { title, file, line, verdict } ]                   // refuted as false-positive
}
```

### Where it fits

It is the **heavier, billed** counterpart to the `/sweep`-in-`/ship-it` step:
`/ship-it`'s inline `/sweep` catches _known_ pattern-class bugs across files; `audit-gate`
runs the _find_ stage itself as a multi-lens fan-out for a whole increment. Use it for
larger bundles / closures where one auditor pass is not enough — the same trigger as
`/multi-round-audit`, but parallel-by-dimension instead of serial-by-round.
