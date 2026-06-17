import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeCrmClient, HttpCrmClient } from "../src/crm-client.js";
import type { CrmLeadEvent } from "../src/crm-event.js";

const ev: CrmLeadEvent = {
  accountKey: "k",
  channel: "voice",
  direction: "outbound",
  type: "call",
};

type CapturedInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
};

describe("FakeCrmClient", () => {
  it("records emitted events", async () => {
    const f = new FakeCrmClient();
    await f.emit(ev);
    expect(f.events).toEqual([ev]);
  });
  it("throws when configured to fail (so the pump leaves the row unsynced)", async () => {
    await expect(new FakeCrmClient({ fail: true }).emit(ev)).rejects.toThrow();
  });
});

describe("HttpCrmClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to <base>/events with a bearer + JSON body", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: CapturedInit) =>
        ({
          ok: true,
          status: 201,
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    await new HttpCrmClient("http://vlcrm:3355/", "key-at-least-16-chars").emit(
      ev,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://vlcrm:3355/events"); // trailing slash collapsed
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer key-at-least-16-chars");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toMatchObject({
      accountKey: "k",
      channel: "voice",
    });
  });

  it("omits the authorization header when no apiKey is given", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: CapturedInit) =>
        ({
          ok: true,
          status: 201,
          text: async () => "",
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    await new HttpCrmClient("http://vlcrm:3355").emit(ev);
    expect(
      fetchMock.mock.calls[0]![1].headers["authorization"],
    ).toBeUndefined();
  });

  it("throws on a non-2xx response (→ pump retries)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            text: async () => "bad",
          }) as unknown as Response,
      ),
    );
    await expect(
      new HttpCrmClient("http://vlcrm:3355").emit(ev),
    ).rejects.toThrow(/400/);
  });
});
