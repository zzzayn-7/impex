import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));

import RootLayout from "@/app/layout";
import { POST as login } from "@/app/api/auth/login/route";
import { PUT as saveTheme } from "@/app/api/theme/route";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { ACCENTS, BACKGROUNDS, themeCss } from "@/lib/theme";

const AUTH = "http://auth-service:8000";
const TOKEN = "tenant-token-abc";
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "olivia@acme.example", full_name: "Olivia Owner", role: "organization-admin", organization_id: "22222222-2222-4222-8222-222222222222", is_active: true, created_at: "x" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let upstream: (call: Call) => Response | Promise<Response>;

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = AUTH;
  calls = [];
  for (const key of Object.keys(jar)) delete jar[key];
  upstream = () => json(404, {});
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return upstream(call);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const put = (body: unknown, cookie: string | null = `${TENANT_SESSION_COOKIE}=${TOKEN}`, raw = false) =>
  saveTheme(new NextRequest("http://localhost:3001/api/theme", { method: "PUT", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));

describe("PUT /api/theme", () => {
  it("saves the two identifiers against the session's own user in the Auth Service, and refreshes the cache cookie from what was saved", async () => {
    upstream = (call) => json(200, { ...USER, theme_background: call.body.background, theme_accent: call.body.accent });
    const res = await put({ background: "ice", accent: "muted-copper" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: { background: "ice", accent: "muted-copper" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${AUTH}/api/v1/auth/me/theme`, method: "PUT", body: { background: "ice", accent: "muted-copper" } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("impex_tenant_theme=ice.muted-copper");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("path=/");
    expect(setCookie.toLowerCase()).not.toContain("httponly"); // a styling cache the page may refresh, never a credential
    expect(setCookie).not.toContain(TOKEN);
  });

  it("forwards ONLY the two identifiers: no user id, role, organization or CSS the browser might add", async () => {
    upstream = () => json(200, USER);
    await put({ background: "graphite", accent: "frost-blue", user_id: "someone-else", role: "super-admin", organization_id: "other", css: "body{display:none}" });
    expect(calls[0].body).toEqual({ background: "graphite", accent: "frost-blue" });
    expect(Object.keys(calls[0].body)).toEqual(["background", "accent"]);
  });

  it("every approved pairing is accepted", async () => {
    upstream = () => json(200, USER);
    for (const b of BACKGROUNDS) for (const a of ACCENTS) expect((await put({ background: b.id, accent: a.id })).status, `${b.id} + ${a.id}`).toBe(200);
    expect(calls).toHaveLength(48);
  });

  it.each([
    [{ background: "#35232E", accent: "pale-butter" }],
    [{ background: "burgundy", accent: "#E8D8A4" }],
    [{ background: "burgundy; background:url(//evil.example)", accent: "pale-butter" }],
    [{ background: "<script>alert(1)</script>", accent: "pale-butter" }],
    [{ background: "Burgundy", accent: "pale-butter" }],
    [{ background: "burgundy" }],
    [{ accent: "pale-butter" }],
    [{ background: 3, accent: ["pale-butter"] }],
    [{}],
    [null],
  ])("refuses anything that is not two approved identifiers (%j) without asking the Auth Service", async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses an unreadable body", async () => {
    expect((await put("{not json", undefined, true)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("needs this portal's own session: no cookie, or a Super Admin portal cookie, is a 401 and nothing is saved", async () => {
    expect((await put({ background: "ice", accent: "frost-blue" }, null)).status).toBe(401);
    expect((await put({ background: "ice", accent: "frost-blue" }, "impex_session=super-admin-token")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([[401, 401], [422, 400], [500, 502], [503, 502]])("maps an Auth Service answer of %i to %i, and sets no cookie", async (from, to) => {
    upstream = () => json(from, { detail: "x" });
    const res = await put({ background: "ice", accent: "frost-blue" });
    expect(res.status).toBe(to);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("an unreachable Auth Service is a 503 (never pretended)", async () => {
    upstream = () => { throw new Error("connection refused"); };
    const res = await put({ background: "ice", accent: "frost-blue" });
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the root layout paints the saved colours on the first byte (no flash, nothing to mismatch)", () => {
  const render = () => renderToStaticMarkup(RootLayout({ children: "PAGE" }) as any);

  it("puts the three data attributes on <html> from the cache cookie, and injects the theme CSS once", () => {
    jar.impex_tenant_theme = "ice.dusty-rose";
    const out = render();
    expect(out).toContain('<html lang="en" data-ix-bg="ice" data-ix-accent="dusty-rose" data-ix-scheme="light">');
    expect(out.match(/<style id="ix-theme">/g)).toHaveLength(1);
    expect(out).toContain(themeCss().split("\n")[0].slice(0, 60));
    expect(out).toContain("PAGE");
  });

  it.each([undefined, "", "ice", "red.blue", "ice.dusty-rose.x", "\"><script>alert(1)</script>.pale-butter", "ice;dusty-rose"])("any other cookie (%j) is ignored: the default theme", (value) => {
    if (value !== undefined) jar.impex_tenant_theme = value;
    expect(render()).toContain('data-ix-bg="original" data-ix-accent="pale-butter" data-ix-scheme="dark"');
    expect(render()).not.toContain("<script");
  });

  it("each portal reads only its own cache cookie", () => {
    jar.impex_theme = "ice.dusty-rose"; // the Super Admin portal's cookie
    expect(render()).toContain('data-ix-bg="original"');
  });
});

describe("signing in refreshes the cache cookie from the Auth Service's record", () => {
  const signIn = () => login(new NextRequest("http://localhost:3001/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "olivia@acme.example", password: "pw" }) }));

  it("an administrator who chose a theme gets it from the first page after sign-in, on any browser", async () => {
    upstream = (call) => (call.url.endsWith("/auth/login") ? json(200, { access_token: TOKEN, expires_in: 3600 }) : json(200, { ...USER, theme_background: "deep-steel-blue", theme_accent: "silver-pearl" }));
    const res = await signIn();
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith("impex_tenant_theme="))).toContain("impex_tenant_theme=deep-steel-blue.silver-pearl");
    expect(cookies.find((c) => c.startsWith(`${TENANT_SESSION_COOKIE}=`))!.toLowerCase()).toContain("httponly");
  });

  it("someone who never chose one (null) or whose record holds something unapproved gets the default", async () => {
    upstream = (call) => (call.url.endsWith("/auth/login") ? json(200, { access_token: TOKEN, expires_in: 3600 }) : json(200, { ...USER, theme_background: "red; x", theme_accent: null }));
    const res = await signIn();
    expect(res.headers.getSetCookie().find((c) => c.startsWith("impex_tenant_theme="))).toContain("impex_tenant_theme=original.pale-butter");
  });
});
