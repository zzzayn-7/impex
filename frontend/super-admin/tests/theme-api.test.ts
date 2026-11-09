import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));

import RootLayout from "@/app/layout";
import { POST as login } from "@/app/api/auth/login/route";
import { PUT as saveTheme } from "@/app/api/theme/route";
import { SESSION_COOKIE } from "@/lib/session";
import { ACCENTS, BACKGROUNDS } from "@/lib/theme";
import { superAdmin } from "./helpers";

const AUTH = "http://auth-service:8000";
const TOKEN = "super-admin-token";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
let upstream: (call: Call) => Response;

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

const put = (body: unknown, cookie: string | null = `${SESSION_COOKIE}=${TOKEN}`) =>
  saveTheme(new NextRequest("http://localhost:3000/api/theme", { method: "PUT", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("PUT /api/theme (Super Admin Portal)", () => {
  it("saves the two identifiers for the Super Admin's own account and refreshes THIS portal's cache cookie", async () => {
    upstream = (call) => json(200, { ...superAdmin, theme_background: call.body.background, theme_accent: call.body.accent });
    const res = await put({ background: "graphite", accent: "dusty-rose", user_id: "someone-else", role: "organization-admin" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${AUTH}/api/v1/auth/me/theme`, method: "PUT", body: { background: "graphite", accent: "dusty-rose" } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("impex_theme=graphite.dusty-rose");
    expect(cookie).not.toContain("impex_tenant_theme"); // the Organization portal's cookie is never touched from here
  });

  it("accepts every approved pairing and refuses everything else without asking the Auth Service", async () => {
    upstream = () => json(200, superAdmin);
    for (const b of BACKGROUNDS) for (const a of ACCENTS) expect((await put({ background: b.id, accent: a.id })).status).toBe(200);
    calls = [];
    for (const bad of [{ background: "#35232E", accent: "pale-butter" }, { background: "ice", accent: "red" }, { background: "ice" }, {}, { background: "ice; x", accent: "pale-butter" }]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("needs the Super Admin portal's own session: nothing, or an organization portal cookie, is a 401", async () => {
    expect((await put({ background: "ice", accent: "frost-blue" }, null)).status).toBe(401);
    expect((await put({ background: "ice", accent: "frost-blue" }, "impex_tenant_session=tenant-token")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([[401, 401], [422, 400], [500, 502]])("maps an Auth Service answer of %i to %i without setting a cookie", async (from, to) => {
    upstream = () => json(from, {});
    const res = await put({ background: "ice", accent: "frost-blue" });
    expect(res.status).toBe(to);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the root layout (Super Admin Portal)", () => {
  const render = () => renderToStaticMarkup(RootLayout({ children: "PAGE" }) as any);

  it("paints the saved colours from ITS OWN cookie, and ignores anything that is not two approved identifiers", () => {
    jar.impex_theme = "deep-purple.lavender-mist";
    expect(render()).toContain('data-ix-bg="deep-purple" data-ix-accent="lavender-mist" data-ix-scheme="dark"');
    jar.impex_theme = "ice.<script>";
    expect(render()).toContain('data-ix-bg="original" data-ix-accent="pale-butter"');
    delete jar.impex_theme;
    jar.impex_tenant_theme = "ice.dusty-rose"; // the Organization portal's: never read here
    expect(render()).toContain('data-ix-bg="original"');
    expect(render().match(/<style id="ix-theme">/g)).toHaveLength(1);
  });
});

describe("Super Admin sign-in refreshes the cache cookie from the Auth Service's record", () => {
  it("a Super Admin who chose a theme gets it from the first page after sign-in", async () => {
    upstream = (call) => (call.url.endsWith("/auth/login") ? json(200, { access_token: TOKEN, expires_in: 3600 }) : json(200, { ...superAdmin, theme_background: "ice", theme_accent: "sage-silver" }));
    const res = await login(new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "root@impex.example", password: "pw" }) }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith("impex_theme="))).toContain("impex_theme=ice.sage-silver");
    expect(cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.toLowerCase()).toContain("httponly");
  });
});
