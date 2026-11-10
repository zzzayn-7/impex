import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeSetupFailure, setupNeed } from "@/lib/onboarding";
import { checkCompanyName, checkFullName, checkLogoFile, monogram } from "@/lib/setup-validation";
import { GET as getLogo } from "@/app/api/organization/logo/route";
import { DELETE as removeLogo, POST as uploadLogo } from "@/app/api/setup/logo/route";
import { PUT as saveCompany } from "@/app/api/setup/company/route";
import { PUT as saveProfile } from "@/app/api/setup/profile/route";
import { POST as completeSetup } from "@/app/api/setup/complete/route";

const TOKEN = "session-token-abc";
const AUTH = "http://auth-service:8000";
const ORG = "http://organization-service:8001";
const OTHER_ORG_ID = "b2e5c1d4-7a8f-4c3b-9d21-0f6e5a4b3c2d";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { url: string; method: string; headers: Record<string, string>; body: any }[];
let handler: (url: string, init: any) => Response | Promise<Response>;

function stub(h: typeof handler) {
  calls = [];
  handler = h;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return handler(String(input), init);
  }));
}
const sent = (i = 0) => calls[i];
const bodyOf = (i = 0) => JSON.parse(calls[i].body);

const request = (method: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, headers = {} as Record<string, string> } = {}) =>
  new NextRequest("http://localhost:3001/api/setup/x", {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : typeof body === "string" ? body : JSON.stringify(body),
  });

const png = (size = 1000, type = "image/png") => new File([new Uint8Array(size)], "logo.png", { type });
const upload = (file: File | null, extra: Record<string, string> = {}) => {
  const form = new FormData();
  if (file) form.set("file", file);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return request("POST", form);
};

const STATUS = { setup_status: "in_progress", setup_completed_at: null, company_name: "Alpha Trading", has_logo: true, logo_version: "17", can_edit: true };
const COMPLETED = { ...STATUS, setup_status: "completed", can_edit: false };

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = AUTH;
  process.env.ORG_SERVICE_URL = ORG;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

// =====================================================================================================
// who must go through setup (the one rule)
// =====================================================================================================
describe("setupNeed", () => {
  const done = "2026-11-03T00:05:00+00:00";
  it.each([
    ["company not set up", "pending", null, { required: true, mode: "full" }],
    ["company set up half way", "in_progress", done, { required: true, mode: "full" }],
    ["company done, this administrator not", "completed", null, { required: true, mode: "profile" }],
    ["everything done", "completed", done, { required: false }],
  ])("%s", (_name, status, profile, expected) => {
    expect(setupNeed({ profile_setup_completed_at: profile as string | null }, { setup_status: status as any })).toEqual(expected);
  });
  it("fails closed when a record says nothing at all", () => {
    expect(setupNeed({}, {})).toEqual({ required: true, mode: "full" });
    expect(setupNeed({}, { setup_status: "completed" })).toEqual({ required: true, mode: "profile" });
    expect(setupNeed({ profile_setup_completed_at: "" }, { setup_status: "completed" })).toEqual({ required: true, mode: "profile" });
  });
});

// =====================================================================================================
// the shared checks
// =====================================================================================================
describe("name and logo checks", () => {
  it.each([["  Alpha   Trading  GmbH ", "Alpha Trading GmbH"], ["A & B Traders (Pvt.) Ltd.", "A & B Traders (Pvt.) Ltd."], ["L’Oréal", "L’Oréal"], ["株式会社 インペックス", "株式会社 インペックス"]])("company %s", (typed, saved) => {
    expect(checkCompanyName(typed)).toEqual({ ok: true, value: saved });
  });
  it.each(["", "  ", "A", "x".repeat(121), "<script>", "Acme\u0000", "Acme {x}", "$$$", "...", 5, null, undefined])("refuses the company name %j", (bad) => {
    expect(checkCompanyName(bad).ok).toBe(false);
  });
  it.each([["  Ada   Lovelace ", "Ada Lovelace"], ["Zoë O’Brien-Smith", "Zoë O’Brien-Smith"], ["李 小龍", "李 小龍"], ["J. R. R. Tolkien", "J. R. R. Tolkien"]])("name %s", (typed, saved) => {
    expect(checkFullName(typed)).toEqual({ ok: true, value: saved });
  });
  it.each(["", " ", "A", "x".repeat(101), "<b>", "Jane 3rd", "...", "Bob\u0000", 5, null])("refuses the name %j", (bad) => {
    expect(checkFullName(bad).ok).toBe(false);
  });
  it("only PNG, JPEG and WebP up to 2 MB", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) expect(checkLogoFile({ type, size: 1000 })).toBeNull();
    for (const type of ["image/svg+xml", "image/gif", "application/pdf", "text/html", ""]) expect(checkLogoFile({ type, size: 1000 })).not.toBeNull();
    expect(checkLogoFile({ type: "image/png", size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkLogoFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(checkLogoFile({ type: "image/png", size: 0 })).not.toBeNull();
  });
  it("monogram: up to two capitals, or the platform mark", () => {
    expect(monogram("Alpha Trading GmbH")).toBe("AT");
    expect(monogram("acme")).toBe("A");
    expect(monogram("  & (Pvt) 7up ")).toBe("P7");
    expect(monogram("")).toBe("IX");
    expect(monogram("---")).toBe("IX");
  });
});

describe("describeSetupFailure", () => {
  it("is calm and recoverable when a service cannot be reached", () => {
    expect(describeSetupFailure(null)).toMatchObject({ status: 503, code: "unavailable" });
  });
  it("passes a service's own code and message through", () => {
    expect(describeSetupFailure({ status: 409, data: { detail: { code: "logo_required", message: "Upload your company logo to finish setup." } } })).toEqual({ status: 409, message: "Upload your company logo to finish setup.", code: "logo_required" });
    expect(describeSetupFailure({ status: 413, data: { detail: { code: "file_too_large", message: "The logo must be 2 MB or smaller." } } }, "logo")).toMatchObject({ status: 413, code: "file_too_large" });
    expect(describeSetupFailure({ status: 422, data: { detail: { code: "invalid_name", message: "Use letters only." } } })).toEqual({ status: 400, message: "Use letters only.", code: "invalid_name" });
  });
  it("never leaks a raw validation payload", () => {
    const f = describeSetupFailure({ status: 422, data: { detail: [{ loc: ["body", "x"], msg: "secret internals" }] } });
    expect(JSON.stringify(f)).not.toContain("internals");
  });
  it("maps expired sessions and unexpected answers", () => {
    expect(describeSetupFailure({ status: 401, data: null }).code).toBe("unauthorized");
    expect(describeSetupFailure({ status: 500, data: { detail: "Traceback ..." } })).toMatchObject({ status: 502, message: "That could not be completed. Please try again." });
  });
});

// =====================================================================================================
// the logo (company identity)
// =====================================================================================================
describe("GET /api/organization/logo", () => {
  const image = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "Content-Type": "image/png", ETag: '"17"' } });
  it("hands the logo to the browser as a plain image, with the caller's own token and nothing that names an organization", async () => {
    stub(() => image());
    const res = await getLogo(request("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("etag")).toBe('"17"');
    expect(new Uint8Array(await res.arrayBuffer())[1]).toBe(0x50);
    expect(sent().url).toBe(`${ORG}/api/v1/tenant/organization/logo`);
    expect(sent().headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
  it("ignores a `v` cache-buster and anything that tries to name an organization", async () => {
    stub(() => image());
    const req = new NextRequest(`http://localhost:3001/api/organization/logo?v=17&organization_id=${OTHER_ORG_ID}`, { headers: { cookie: `impex_tenant_session=${TOKEN}`, "x-organization-id": OTHER_ORG_ID } });
    await getLogo(req);
    expect(sent().url).toBe(`${ORG}/api/v1/tenant/organization/logo`);
    expect(JSON.stringify(sent().headers)).not.toContain(OTHER_ORG_ID);
  });
  it("passes a conditional request on and answers 304", async () => {
    stub(() => new Response(null, { status: 304, headers: { ETag: '"17"' } }));
    const res = await getLogo(request("GET", undefined, { headers: { "if-none-match": '"17"' } }));
    expect(res.status).toBe(304);
    expect(sent().headers["If-None-Match"]).toBe('"17"');
  });
  it.each([[404, 404], [401, 401], [403, 403], [500, 503]])("answers %i with %i and no image", async (upstream, expected) => {
    stub(() => json(upstream, { detail: "x" }));
    const res = await getLogo(request("GET"));
    expect(res.status).toBe(expected);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
  it("needs a session, and answers 503 when the service is down", async () => {
    expect((await getLogo(request("GET", undefined, { cookie: "" }))).status).toBe(401);
    expect(calls).toHaveLength(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await getLogo(request("GET"))).status).toBe(503);
  });
});

describe("POST /api/setup/logo", () => {
  it("forwards one validated file to the Organization Service with the caller's token", async () => {
    stub(() => json(200, STATUS));
    const res = await uploadLogo(upload(png(1234)));
    expect(res.status).toBe(200);
    expect((await res.json()).setup).toEqual(STATUS);
    expect(sent().url).toBe(`${ORG}/api/v1/tenant/onboarding/logo`);
    expect(sent().method).toBe("PUT");
    expect(sent().headers).toEqual({ Authorization: `Bearer ${TOKEN}` }); // no JSON content type: the multipart boundary is the browser/undici's
    const file = (sent().body as FormData).get("file") as File;
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(1234);
    expect([...(sent().body as FormData).keys()]).toEqual(["file"]);
  });
  it("sends nothing but the file: a browser-supplied organization or user is dropped", async () => {
    stub(() => json(200, STATUS));
    await uploadLogo(upload(png(), { organization_id: OTHER_ORG_ID, user_id: "x" }));
    expect([...(sent().body as FormData).keys()]).toEqual(["file"]);
    expect(sent().url).not.toContain(OTHER_ORG_ID);
  });
  it.each([
    ["an SVG", new File(["<svg/>"], "l.svg", { type: "image/svg+xml" })],
    ["a GIF", new File(["GIF89a"], "l.gif", { type: "image/gif" })],
    ["a PDF", new File(["%PDF"], "l.pdf", { type: "application/pdf" })],
    ["an oversized file", png(2 * 1024 * 1024 + 1)],
    ["an empty file", png(0)],
  ])("refuses %s without calling the service", async (_name, file) => {
    const res = await uploadLogo(upload(file));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("refuses a missing file, a text field posing as a file, and a non-multipart request", async () => {
    expect((await uploadLogo(upload(null))).status).toBe(400);
    const form = new FormData();
    form.set("file", "not a file");
    expect((await uploadLogo(request("POST", form))).status).toBe(400);
    expect((await uploadLogo(request("POST", { file: "x" }))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });
  it("needs a session", async () => {
    expect((await uploadLogo(request("POST", new FormData(), { cookie: "" }))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it.each([
    [413, { detail: { code: "file_too_large", message: "The logo must be 2 MB or smaller." } }, "file_too_large"],
    [415, { detail: { code: "unsupported_type", message: "Use a PNG, JPEG or WebP image." } }, "unsupported_type"],
    [422, { detail: { code: "invalid_image", message: "This file is not a valid PNG, JPEG or WebP image." } }, "invalid_image"],
    [422, { detail: { code: "too_small", message: "The logo must be at least 64 x 64 pixels." } }, "too_small"],
    [409, { detail: { code: "setup_completed", message: "Company setup is already completed." } }, "setup_completed"],
    [503, { detail: { code: "storage_unavailable", message: "The logo could not be saved right now." } }, "storage_unavailable"],
  ])("explains the service's refusal (%i %s)", async (status, body, code) => {
    stub(() => json(status, body));
    const res = await uploadLogo(upload(png()));
    expect(res.status).toBe(status === 422 ? 400 : status);
    const out = await res.json();
    expect(out.code).toBe(code);
    expect(out.error).toBe((body.detail as any).message);
  });
  it("is a recoverable 503 when the service cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const res = await uploadLogo(upload(png()));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("unavailable");
  });
});

describe("DELETE /api/setup/logo", () => {
  it("removes the logo for the caller's organization", async () => {
    stub(() => json(200, { ...STATUS, has_logo: false, logo_version: null }));
    const res = await removeLogo(request("DELETE"));
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ url: `${ORG}/api/v1/tenant/onboarding/logo`, method: "DELETE" });
  });
  it("needs a session and passes a refusal on", async () => {
    expect((await removeLogo(request("DELETE", undefined, { cookie: "" }))).status).toBe(401);
    stub(() => json(409, { detail: { code: "setup_completed", message: "Company setup is already completed." } }));
    expect((await removeLogo(request("DELETE"))).status).toBe(409);
  });
});

// =====================================================================================================
// company name and the administrator's name
// =====================================================================================================
describe("PUT /api/setup/company", () => {
  it("sends only the cleaned name; the organization comes from the token", async () => {
    stub(() => json(200, STATUS));
    const res = await saveCompany(request("PUT", { companyName: "  Alpha   Trading ", slug: "hijack", organization_id: OTHER_ORG_ID, country_code: "US", setup_status: "completed" }));
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ url: `${ORG}/api/v1/tenant/onboarding/company`, method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    expect(bodyOf()).toEqual({ name: "Alpha Trading" });
  });
  it.each(["", "A", "<b>", "x".repeat(121), 5])("refuses the name %j with a field error and no request", async (bad) => {
    const res = await saveCompany(request("PUT", { companyName: bad }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.companyName).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it("needs a session and a JSON body", async () => {
    expect((await saveCompany(request("PUT", { companyName: "Acme" }, { cookie: "" }))).status).toBe(401);
    expect((await saveCompany(request("PUT", undefined))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });
  it("tells the browser when setup is already closed or the service refuses the name", async () => {
    stub(() => json(409, { detail: { code: "setup_completed", message: "Company setup is already completed." } }));
    expect((await saveCompany(request("PUT", { companyName: "Acme Ltd" }))).status).toBe(409);
    stub(() => json(422, { detail: { code: "invalid_company_name", message: "Enter your company name." } }));
    const res = await saveCompany(request("PUT", { companyName: "Acme Ltd" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.companyName).toBe("Enter your company name.");
  });
});

describe("PUT /api/setup/profile", () => {
  it("changes only the caller's own full name, through the Auth Service", async () => {
    stub(() => json(200, { id: "u", full_name: "Ada Lovelace", email: "a@b.c" }));
    const res = await saveProfile(request("PUT", { fullName: " Ada   Lovelace ", role: "super-admin", email: "evil@x.y", organization_id: OTHER_ORG_ID, user_id: "someone-else", password: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { full_name: "Ada Lovelace" } });
    expect(sent()).toMatchObject({ url: `${AUTH}/api/v1/auth/me/profile`, method: "PATCH", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(bodyOf()).toEqual({ full_name: "Ada Lovelace" }); // nothing else can travel
  });
  it.each(["", "A", "<b>", "Jane 3rd", "x".repeat(101), 7])("refuses %j with a field error and no request", async (bad) => {
    const res = await saveProfile(request("PUT", { fullName: bad }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.fullName).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it("needs a session; maps the Auth Service's answers", async () => {
    expect((await saveProfile(request("PUT", { fullName: "Ada Lovelace" }, { cookie: "" }))).status).toBe(401);
    stub(() => json(403, { detail: { code: "not_an_organization_admin", message: "Profile setup is only for organization administrators." } }));
    expect((await saveProfile(request("PUT", { fullName: "Ada Lovelace" }))).status).toBe(403);
    stub(() => json(401, { detail: "Invalid or expired token" }));
    expect((await saveProfile(request("PUT", { fullName: "Ada Lovelace" }))).status).toBe(401);
  });
});

// =====================================================================================================
// completing: the two-service saga
// =====================================================================================================
describe("POST /api/setup/complete", () => {
  const world = (opts: { status?: any; orgComplete?: () => Response; authComplete?: () => Response } = {}) =>
    stub((url) => {
      if (url === `${ORG}/api/v1/tenant/onboarding`) return json(200, opts.status ?? STATUS);
      if (url === `${ORG}/api/v1/tenant/onboarding/complete`) return opts.orgComplete ? opts.orgComplete() : json(200, COMPLETED);
      if (url === `${AUTH}/api/v1/auth/me/profile/complete`) return opts.authComplete ? opts.authComplete() : json(200, { full_name: "Ada Lovelace", profile_setup_completed_at: "2026-11-07T10:00:00+00:00" });
      return json(404, {});
    });
  const ask = (body: unknown = { companyName: "Alpha Trading", fullName: "Ada Lovelace" }) => completeSetup(request("POST", body));
  const urls = () => calls.map((c) => `${c.method} ${c.url.replace(ORG, "ORG").replace(AUTH, "AUTH")}`);

  it("finishes the company first, then the profile, and sends the browser to the dashboard", async () => {
    world();
    const res = await ask({ companyName: " Alpha   Trading ", fullName: " Ada   Lovelace " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, redirectTo: "/" });
    expect(urls()).toEqual(["GET ORG/api/v1/tenant/onboarding", "POST ORG/api/v1/tenant/onboarding/complete", "POST AUTH/api/v1/auth/me/profile/complete"]);
    expect(bodyOf(1)).toEqual({ company_name: "Alpha Trading" });
    expect(bodyOf(2)).toEqual({ full_name: "Ada Lovelace" });
    for (const call of calls) expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
  it("names no organization and no user anywhere", async () => {
    world();
    await ask({ companyName: "Alpha Trading", fullName: "Ada Lovelace", organization_id: OTHER_ORG_ID, user_id: "someone-else", setup_status: "completed" });
    const everything = JSON.stringify(calls.map((c) => [c.url, c.body]));
    expect(everything).not.toContain(OTHER_ORG_ID);
    expect(everything).not.toContain("someone-else");
    expect(everything).not.toContain("setup_status\":\"completed");
  });
  it("a company that is already set up is not touched again (a new administrator, or a retry)", async () => {
    world({ status: COMPLETED });
    const res = await ask({ fullName: "Ada Lovelace" }); // no company name needed
    expect(res.status).toBe(200);
    expect(urls()).toEqual(["GET ORG/api/v1/tenant/onboarding", "POST AUTH/api/v1/auth/me/profile/complete"]);
  });
  it("does not touch the profile when the company cannot be completed (nothing is half done)", async () => {
    world({ orgComplete: () => json(409, { detail: { code: "logo_required", message: "Upload your company logo to finish setup." } }) });
    const res = await ask();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("logo_required");
    expect(urls()).not.toContain("POST AUTH/api/v1/auth/me/profile/complete");
  });
  it("if the profile fails AFTER the company succeeded, it says so, keeps the company completed, and a retry finishes just the profile", async () => {
    world({ authComplete: () => json(503, { detail: "boom" }) });
    const first = await ask();
    expect(first.status).toBe(503);
    const body = await first.json();
    expect(body.companySetupDone).toBe(true);
    expect(body.error).toContain("Your company was set up");
    world({ status: COMPLETED }); // what the Organization Service now says
    const retry = await ask();
    expect(retry.status).toBe(200);
    expect(urls()).toEqual(["GET ORG/api/v1/tenant/onboarding", "POST AUTH/api/v1/auth/me/profile/complete"]);
  });
  it("a service outage while reading the state is a recoverable 503 and changes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const res = await ask();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("unavailable");
  });
  it("an Auth Service outage after the company is done is also recoverable", async () => {
    stub((url) => {
      if (url.endsWith("/tenant/onboarding")) return json(200, COMPLETED);
      throw new Error("auth down");
    });
    const res = await ask({ fullName: "Ada Lovelace" });
    expect(res.status).toBe(503);
  });
  it("refuses a bad name or a missing company name without calling any service", async () => {
    expect((await ask({ companyName: "Acme", fullName: "<b>" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    world();
    const res = await ask({ fullName: "Ada Lovelace" }); // company not completed and no name sent
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.companyName).toBeTruthy();
    expect(urls()).toEqual(["GET ORG/api/v1/tenant/onboarding"]);
  });
  it("needs a session and a JSON body; an expired session is passed on as 401", async () => {
    expect((await completeSetup(request("POST", { fullName: "Ada Lovelace" }, { cookie: "" }))).status).toBe(401);
    expect((await completeSetup(request("POST", undefined))).status).toBe(415);
    expect(calls).toHaveLength(0);
    stub(() => json(401, { detail: "Missing, invalid or expired token" }));
    expect((await ask()).status).toBe(401);
  });
  it("is safe to repeat: the second call changes nothing more than the first", async () => {
    world();
    await ask();
    world({ status: COMPLETED });
    const again = await ask();
    expect(again.status).toBe(200);
    expect(urls().filter((u) => u.includes("onboarding/complete"))).toEqual([]);
  });
});

// =====================================================================================================
// the default currency chosen in the wizard
// =====================================================================================================
describe("the default currency in setup", () => {
  const completeWorld = (orgComplete?: () => Response) =>
    stub((url) => {
      if (url === `${ORG}/api/v1/tenant/onboarding`) return json(200, STATUS);
      if (url === `${ORG}/api/v1/tenant/onboarding/complete`) return orgComplete ? orgComplete() : json(200, COMPLETED);
      if (url === `${AUTH}/api/v1/auth/me/profile/complete`) return json(200, { full_name: "Ada Lovelace", profile_setup_completed_at: "2026-11-07T10:00:00+00:00" });
      return json(404, {});
    });

  it("PUT /api/setup/company forwards the chosen currency with the name, and nothing else", async () => {
    stub(() => json(200, STATUS));
    const res = await saveCompany(request("PUT", { companyName: "Alpha Trading", defaultCurrency: "USD", country_code: "US", slug: "x" }));
    expect(res.status).toBe(200);
    expect(bodyOf()).toEqual({ name: "Alpha Trading", default_currency: "USD" });
  });

  it("PUT /api/setup/company without a currency sends none (an older page keeps working)", async () => {
    stub(() => json(200, STATUS));
    await saveCompany(request("PUT", { companyName: "Alpha Trading" }));
    expect(bodyOf()).toEqual({ name: "Alpha Trading" });
  });

  it.each(["usd", "US", "USDX", "XXX", "", " USD", 1, null, ["USD"], { code: "USD" }])("PUT /api/setup/company refuses %j before anything is sent", async (bad) => {
    const res = await saveCompany(request("PUT", { companyName: "Alpha Trading", defaultCurrency: bad }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.defaultCurrency).toBe("Choose your currency from the list.");
    expect(calls).toHaveLength(0);
  });

  it("PUT /api/setup/company shows the service's refusal next to the field", async () => {
    stub(() => json(422, { detail: { code: "invalid_currency", message: "Choose a valid currency from the list." } }));
    const res = await saveCompany(request("PUT", { companyName: "Alpha Trading", defaultCurrency: "EUR" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.defaultCurrency).toBe("Choose a valid currency from the list.");
  });

  it("POST /api/setup/complete confirms the currency in the company step of the saga", async () => {
    completeWorld();
    const res = await completeSetup(request("POST", { companyName: "Alpha Trading", fullName: "Ada Lovelace", defaultCurrency: "GBP" }));
    expect(res.status).toBe(200);
    const complete = calls.find((c) => c.url === `${ORG}/api/v1/tenant/onboarding/complete`)!;
    expect(JSON.parse(complete.body)).toEqual({ company_name: "Alpha Trading", default_currency: "GBP" });
  });

  it("POST /api/setup/complete refuses a bad currency before the company is touched", async () => {
    completeWorld();
    const res = await completeSetup(request("POST", { companyName: "Alpha Trading", fullName: "Ada Lovelace", defaultCurrency: "ABC" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.defaultCurrency).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/onboarding/complete") || c.url.endsWith("/profile/complete"))).toBe(false);
  });

  it("POST /api/setup/complete maps the service's refusal of the currency", async () => {
    completeWorld(() => json(422, { detail: { code: "invalid_currency", message: "Choose a valid currency from the list." } }));
    const res = await completeSetup(request("POST", { companyName: "Alpha Trading", fullName: "Ada Lovelace", defaultCurrency: "EUR" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.defaultCurrency).toBe("Choose a valid currency from the list.");
  });
});
