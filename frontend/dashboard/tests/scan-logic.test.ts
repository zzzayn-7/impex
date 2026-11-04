import { describe, expect, it, vi } from "vitest";

import { LookupResult, ScanResult, createScanSession, lookupOnServer, normalizeScanned } from "@/lib/scan";

describe("normalizeScanned: what a scanner, a camera or a keyboard produced", () => {
  it.each([
    ["IMX-ABCDEFGHJKMN", "IMX-ABCDEFGHJKMN"],
    ["imx-abcdefghjkmn", "IMX-ABCDEFGHJKMN"],
    ["5901234123457", "5901234123457"],
    ["bolt-1", "BOLT-1"],
    ["A.B_C:D/E+F-G", "A.B_C:D/E+F-G"],
  ])("accepts %j as %j", (raw, code) => {
    expect(normalizeScanned(raw)).toEqual({ ok: true, code });
  });

  it.each(["\r", "\n", "\r\n", "\t", "  ", "\r\n\t "])("strips the suffix a scanner is set to send (%j)", (suffix) => {
    expect(normalizeScanned(`BOLT-1${suffix}`)).toEqual({ ok: true, code: "BOLT-1" });
    expect(normalizeScanned(`${suffix}BOLT-1`)).toEqual({ ok: true, code: "BOLT-1" });
  });

  it.each([["]C0IMX-ABCDEFGHJKMN"], ["]Q1IMX-ABCDEFGHJKMN"], ["]E05901234123457"]])("strips an AIM symbology prefix from %j", (raw) => {
    const result = normalizeScanned(raw);
    expect(result.ok).toBe(true);
    expect(result.ok && result.code.startsWith("]")).toBe(false);
  });

  it.each([["", "empty"], ["   ", "empty"], ["\r\n", "empty"], ["]C0", "empty"]])("rejects %j as %s", (raw, reason) => {
    const result = normalizeScanned(raw);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it.each(["http://evil.example/x", "https://evil.example", "HTTPS://EVIL", "ftp://x/y", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"])(
    "refuses the link %j as a link and says it was not opened",
    (raw) => {
      const result = normalizeScanned(raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("link");
      expect(!result.ok && result.message).toContain("not opened");
    }
  );

  it.each(["has space", "ab|cd", "emoji😀", "a\u0000b", "a\u001bb", "<script>", "' OR 1=1 --", "ünïcode", "-leading"])("refuses %j as invalid", (raw) => {
    const result = normalizeScanned(raw);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid");
  });

  it("refuses codes longer than 64 characters but accepts exactly 64", () => {
    expect(normalizeScanned("A".repeat(64)).ok).toBe(true);
    const long = normalizeScanned("A".repeat(65));
    expect(!long.ok && long.reason).toBe("too-long");
  });
});

// ---- a keyboard-emulation scanner "types" the code quickly and finishes with Enter ---------------------------------
describe("the scan session", () => {
  const result = { kind: "found", result: { product: { id: "p1" } } as unknown as ScanResult } as LookupResult;
  const make = (extra: Partial<Parameters<typeof createScanSession>[0]> = {}) => {
    const lookup = vi.fn(async (_code: string): Promise<LookupResult> => result);
    let time = 1_000;
    const session = createScanSession({ lookup, now: () => time, ...extra });
    return { lookup, session, advance: (ms: number) => (time += ms) };
  };

  it("looks a valid code up once, with the normalized value", async () => {
    const { session, lookup } = make();
    const outcome = await session.submit("  imx-abc234defghj\r\n", "scanner");
    expect(outcome).toEqual({ kind: "lookup", code: "IMX-ABC234DEFGHJ", result });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("IMX-ABC234DEFGHJ");
  });

  it("handles what a keyboard-emulating scanner delivers: characters, then Enter", async () => {
    const { session, lookup } = make();
    const typed = [..."5901234123457"].join("") + "\n"; // the input's value when Enter submits the form
    expect((await session.submit(typed, "scanner")).kind).toBe("lookup");
    expect(lookup).toHaveBeenCalledWith("5901234123457");
  });

  it("works the same for manual entry of a SKU", async () => {
    const { session, lookup } = make();
    await session.submit("bolt-1", "manual");
    expect(lookup).toHaveBeenCalledWith("BOLT-1");
  });

  it("ignores the same code arriving again straight away (double Enter, sticky trigger)", async () => {
    const { session, lookup, advance } = make();
    await session.submit("BOLT-1", "scanner");
    advance(200);
    expect(await session.submit("BOLT-1\r", "scanner")).toEqual({ kind: "ignored", reason: "duplicate" });
    advance(200);
    expect(await session.submit("bolt-1", "manual")).toEqual({ kind: "ignored", reason: "duplicate" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("accepts a different code at once, and the same code again after the window", async () => {
    const { session, lookup, advance } = make();
    await session.submit("BOLT-1", "scanner");
    advance(100);
    expect((await session.submit("NUT-1", "scanner")).kind).toBe("lookup");
    advance(100);
    expect((await session.submit("BOLT-1", "scanner")).kind).toBe("lookup"); // A, B, A is three real scans
    advance(2000);
    expect((await session.submit("BOLT-1", "scanner")).kind).toBe("lookup");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("lets the camera repeat itself for longer than a person pressing Enter twice", async () => {
    const { session, lookup, advance } = make();
    await session.submit("BOLT-1", "camera");
    advance(3000);
    expect(await session.submit("BOLT-1", "camera")).toEqual({ kind: "ignored", reason: "duplicate" });
    advance(1500);
    expect((await session.submit("BOLT-1", "camera")).kind).toBe("lookup");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("runs one lookup at a time: scans arriving during a lookup are dropped, not queued", async () => {
    let release!: (value: LookupResult) => void;
    const lookup = vi.fn(() => new Promise<LookupResult>((resolve) => (release = resolve)));
    const session = createScanSession({ lookup, now: () => 0 });
    const first = session.submit("BOLT-1", "scanner");
    expect(await session.submit("NUT-1", "scanner")).toEqual({ kind: "ignored", reason: "busy" });
    expect(await session.submit("BOLT-1", "scanner")).toEqual({ kind: "ignored", reason: "busy" });
    release(result);
    expect((await first).kind).toBe("lookup");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not call the server for anything that cannot be a code, including links", async () => {
    const { session, lookup } = make();
    for (const raw of ["", "   ", "https://evil.example/pay", "javascript:alert(1)", "two words", "x".repeat(80)]) {
      expect((await session.submit(raw, "camera")).kind).toBe("rejected");
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("forgets the last code on reset(), so the same label can be scanned again", async () => {
    const { session, lookup, advance } = make();
    await session.submit("BOLT-1", "scanner");
    session.reset();
    advance(10);
    expect((await session.submit("BOLT-1", "scanner")).kind).toBe("lookup");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("is usable again after a failed lookup", async () => {
    const failing = vi.fn().mockResolvedValueOnce({ kind: "unavailable", message: "x" }).mockResolvedValue(result);
    const session = createScanSession({ lookup: failing, now: () => 5000, duplicateWindowMs: 0 });
    expect((await session.submit("BOLT-1", "scanner")).kind).toBe("lookup");
    expect((await session.submit("BOLT-1", "scanner")).kind).toBe("lookup");
  });
});

// ---- lookupOnServer: the browser's only way to resolve a code (the portal's own route) ------------------------------
describe("lookupOnServer", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const found = { matched_by: "sku", identifier_kind: null, product: { id: "p" }, stock: { total_quantity: "1" } };

  it("asks the portal route, with the code URL-encoded, and nothing else", async () => {
    const fetchFn = reply(200, found);
    const outcome = await lookupOnServer("A/B+C", fetchFn as any);
    expect(outcome.kind).toBe("found");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/scan/resolve?code=A%2FB%2BC");
    expect(init.method).toBe("GET");
    expect(JSON.stringify(init)).not.toMatch(/organization|tenant/i);
  });

  it.each([
    [404, "not-found"], [410, "retired"], [409, "ambiguous"], [400, "invalid"], [422, "invalid"], [403, "forbidden"], [401, "unauthorized"], [503, "unavailable"], [500, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const outcome = await lookupOnServer("X", reply(status, { error: "from the server" }) as any);
    expect(outcome.kind).toBe(kind);
    expect("message" in outcome && outcome.message.length).toBeGreaterThan(5);
  });

  it("treats a network failure or a malformed answer as unavailable", async () => {
    expect((await lookupOnServer("X", vi.fn(async () => { throw new Error("offline"); }) as any)).kind).toBe("unavailable");
    expect((await lookupOnServer("X", reply(200, { nothing: true }) as any)).kind).toBe("unavailable");
  });
});
