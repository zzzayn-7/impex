import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as history } from "@/app/api/settings/history/route";
import { PATCH as company } from "@/app/api/settings/company/route";
import { DELETE as removeLogo, PUT as putLogo } from "@/app/api/settings/logo/route";
import { PATCH as profile } from "@/app/api/settings/profile/route";
import { PATCH as preferences } from "@/app/api/settings/preferences/route";
import { describeSettingsFailure, getSettings } from "@/lib/settings";

const TOKEN = "session-token-abc";
const ORG = "http://organization-service:8001";
const AUTH = "http://auth-service:8000";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
function stub(answer: (call: Call) => Response | null) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const response = answer(call);
    if (response === null) throw new Error("connection refused");
    return response;
  }));
}

const request = (method: string, url: string, body?: unknown, { cookie = `impex_tenant_session=${TOKEN}`, headers = {} as Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3001${url}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });

beforeEach(() => {
  process.env.ORG_SERVICE_URL = ORG;
  process.env.AUTH_SERVICE_URL = AUTH;
});
afterEach(() => vi.unstubAllGlobals());

describe("PATCH /api/settings/company", () => {
  const patch = (body: unknown, opts?: Parameters<typeof request>[3]) => company(request("PATCH", "/api/settings/company", body, opts));

  it("forwards only the fields that were sent (normalized), the version and the session token", async () => {
    stub(() => json(200, { version: 4 }));
    const res = await patch({ expected_version: 3, name: "  Alpha   Trading  ", contact_email: " OPS@Alpha.example ", website: "alpha.example" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { version: 4 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORG}/api/v1/tenant/settings/company`);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toEqual({ expected_version: 3, name: "Alpha Trading", contact_email: "ops@alpha.example", website: "https://alpha.example" });
  });

  it("clears an optional field with null, but never the required ones", async () => {
    stub(() => json(200, {}));
    await patch({ expected_version: 1, contact_phone: null, website: null });
    expect(calls[0].body).toEqual({ expected_version: 1, contact_phone: null, website: null });
    calls = [];
    const res = await patch({ expected_version: 1, name: null });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("never forwards the restricted facts or any identity, however they are sent", async () => {
    stub(() => json(200, {}));
    await patch({ expected_version: 1, name: "Alpha Two", id: "x", organization_id: "y", slug: "hijacked", country_code: "US", tax_identifier: "X", is_active: false, setup_status: "pending", primary_admin_email: "evil@x.io", settings_version: 99, default_currency: "EUR", modules: ["finance"] });
    expect(Object.keys(calls[0].body).sort()).toEqual(["expected_version", "name"]);
  });

  it("checks the fields before calling the service, with a message beside the field", async () => {
    stub(() => json(200, {}));
    const res = await patch({ expected_version: 1, name: "A", contact_email: "broken", website: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body.fieldErrors).sort()).toEqual(["contact_email", "name", "website"]);
    expect(calls).toHaveLength(0);
  });

  it("needs a session, a version and something to save", async () => {
    stub(() => json(200, {}));
    expect((await patch({ expected_version: 1, name: "Fine" }, { cookie: null as any })).status).toBe(401);
    expect((await patch({ name: "Fine" })).status).toBe(400);
    expect((await patch({ expected_version: 0, name: "Fine" })).status).toBe(400);
    expect((await patch({ expected_version: "1", name: "Fine" })).status).toBe(400);
    expect((await patch({ expected_version: 1 })).status).toBe(400);
    expect((await company(new NextRequest("http://localhost:3001/x", { method: "PATCH", headers: { cookie: `impex_tenant_session=${TOKEN}` }, body: "x" }))).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("passes a version conflict through with the current settings, so the form can show them", async () => {
    const current = { version: 5, company: { name: "Alpha First" } };
    stub(() => json(409, { detail: { code: "version_conflict", message: "These settings were changed by someone else while you were editing.", current } }));
    const res = await patch({ expected_version: 3, name: "Alpha Second" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "version_conflict", current });
  });

  it("maps a field error from the service to its field", async () => {
    stub(() => json(422, { detail: { code: "invalid_field", field: "contact_email", message: "Enter a valid e-mail address." } }));
    const res = await patch({ expected_version: 1, contact_email: "ok@fine.example" });
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toEqual({ contact_email: "Enter a valid e-mail address." });
  });

  it("explains a service outage, an inactive organization, setup not finished and an expired session, and never repeats raw server text", async () => {
    stub(() => null);
    let res = await patch({ expected_version: 1, name: "Fine" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Nothing was changed");
    stub(() => json(403, { detail: "Your organization is not active." }));
    expect((await patch({ expected_version: 1, name: "Fine" })).status).toBe(403);
    stub(() => json(403, { detail: { code: "setup_required", message: "Finish the first-time setup before using Settings." } }));
    expect((await (await patch({ expected_version: 1, name: "Fine" })).json()).code).toBe("setup_required");
    stub(() => json(401, {}));
    expect((await patch({ expected_version: 1, name: "Fine" })).status).toBe(401);
    stub(() => json(500, { detail: "Traceback: password=hunter2" }));
    expect(JSON.stringify(await (await patch({ expected_version: 1, name: "Fine" })).json())).not.toContain("hunter2");
  });
});

describe("PATCH /api/settings/preferences", () => {
  const patch = (body: unknown) => preferences(request("PATCH", "/api/settings/preferences", body));

  it("forwards only the four preferences and the version", async () => {
    stub(() => json(200, {}));
    await patch({ expected_version: 2, default_currency: "pkr", timezone: "Asia/Karachi", date_format: "DD/MM/YYYY", number_format: "indian", name: "Sneaky", organization_id: "x" });
    expect(calls[0].url).toBe(`${ORG}/api/v1/tenant/settings/preferences`);
    expect(calls[0].body).toEqual({ expected_version: 2, default_currency: "PKR", timezone: "Asia/Karachi", date_format: "DD/MM/YYYY", number_format: "indian" });
  });

  it.each([["default_currency", "DOLLAR"], ["default_currency", ""], ["default_currency", 5], ["date_format", "DD-MM-YYYY"], ["number_format", "weird"], ["timezone", ""], ["timezone", null]])("refuses %s = %j before calling the service", async (field, value) => {
    stub(() => json(200, {}));
    const res = await patch({ expected_version: 1, [field]: value });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).fieldErrors)).toEqual([field]);
    expect(calls).toHaveLength(0);
  });

  it("needs a version and something to change", async () => {
    stub(() => json(200, {}));
    expect((await patch({ default_currency: "EUR" })).status).toBe(400);
    expect((await patch({ expected_version: 1 })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes conflicts and outages through safely", async () => {
    stub(() => json(409, { detail: { code: "version_conflict", message: "changed", current: { version: 9 } } }));
    expect((await (await patch({ expected_version: 1, timezone: "UTC" })).json()).current.version).toBe(9);
    stub(() => null);
    expect((await patch({ expected_version: 1, timezone: "UTC" })).status).toBe(503);
  });
});

describe("the logo routes", () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], "my logo.png", { type: "image/png" });
  const upload = (file: File | string | null, version: string | null = "3", extra: Record<string, string> = {}) => {
    const form = new FormData();
    if (file !== null) form.set("file", file);
    if (version !== null) form.set("expected_version", version);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return putLogo(request("PUT", "/api/settings/logo", form));
  };

  it("forwards one file and the version, nothing else", async () => {
    stub(() => json(200, { version: 4, branding: { has_logo: true } }));
    const res = await upload(png(), "3", { organization_id: "x", logo_storage_key: "aa/k.png" });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${ORG}/api/v1/tenant/settings/logo`);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const form = calls[0].body as FormData;
    expect([...form.keys()].sort()).toEqual(["expected_version", "file"]);
    expect(form.get("expected_version")).toBe("3");
  });

  it("refuses a wrong type, an empty file, a missing file or version before calling the service", async () => {
    stub(() => json(200, {}));
    expect((await upload(new File([new Uint8Array([1, 2, 3])], "x.gif", { type: "image/gif" }))).status).toBe(400);
    expect((await upload(new File([new Uint8Array([1, 2, 3])], "x.svg", { type: "image/svg+xml" }))).status).toBe(400);
    expect((await upload(new File([], "x.png", { type: "image/png" }))).status).toBe(400);
    expect((await upload(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).status).toBe(400);
    expect((await upload(null)).status).toBe(400);
    expect((await upload("not a file")).status).toBe(400);
    expect((await upload(png(), null)).status).toBe(400);
    expect((await upload(png(), "0")).status).toBe(400);
    expect((await putLogo(request("PUT", "/api/settings/logo", { file: "x" }))).status).toBe(415);
    expect((await putLogo(request("PUT", "/api/settings/logo", new FormData(), { cookie: null as any }))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("passes the service's verdict on the picture itself, and conflicts", async () => {
    stub(() => json(400, { detail: { code: "logo_too_small", message: "The logo is too small." } }));
    const res = await upload(png());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The logo is too small.");
    stub(() => json(409, { detail: { code: "version_conflict", message: "changed", current: { version: 8 } } }));
    expect((await (await upload(png())).json()).current.version).toBe(8);
    stub(() => json(503, { detail: { code: "storage_unavailable", message: "The logo could not be saved right now." } }));
    expect((await upload(png())).status).toBe(503);
    stub(() => null);
    expect((await upload(png())).status).toBe(503);
  });

  it("removes the logo with the version", async () => {
    stub(() => json(200, { version: 5, branding: { has_logo: false } }));
    const res = await removeLogo(request("DELETE", "/api/settings/logo?expected_version=4"));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${ORG}/api/v1/tenant/settings/logo?expected_version=4`);
    expect(calls[0].method).toBe("DELETE");
    expect((await removeLogo(request("DELETE", "/api/settings/logo"))).status).toBe(400);
    expect((await removeLogo(request("DELETE", "/api/settings/logo?expected_version=abc"))).status).toBe(400);
    expect((await removeLogo(request("DELETE", "/api/settings/logo?expected_version=4", undefined, { cookie: null as any }))).status).toBe(401);
  });
});

describe("PATCH /api/settings/profile (the administrator's own name)", () => {
  const patch = (body: unknown, opts?: Parameters<typeof request>[3]) => profile(request("PATCH", "/api/settings/profile", body, opts));

  it("sends the name, and only the name, to the Auth Service with the session token (so only the signed-in person can be changed)", async () => {
    stub(() => json(200, { full_name: "Olivia Owner-Smith" }));
    const res = await patch({ fullName: "  Olivia   Owner-Smith ", role: "super-admin", email: "evil@x.io", organization_id: "y", user_id: "z", password: "N3w!" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { full_name: "Olivia Owner-Smith" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${AUTH}/api/v1/auth/me/profile`);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toEqual({ full_name: "Olivia Owner-Smith" });
  });

  it("refuses bad names before calling the service", async () => {
    stub(() => json(200, {}));
    for (const bad of ["", "A", "<b>x</b>", "Jane 3rd", "x".repeat(101), 5, null]) {
      const res = await patch({ fullName: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(Object.keys((await res.json()).fieldErrors)).toEqual(["fullName"]);
    }
    expect((await patch({ fullName: "Olivia" }, { cookie: null as any })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("explains the service's refusal and its outage", async () => {
    stub(() => json(422, { detail: { code: "invalid_name", message: "Use letters only." } }));
    const res = await patch({ fullName: "Olivia" });
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toEqual({ fullName: "Use letters only." });
    stub(() => null);
    expect((await patch({ fullName: "Olivia" })).status).toBe(503);
    stub(() => json(403, { detail: { code: "not_an_organization_admin", message: "Profile setup is only for organization administrators." } }));
    expect((await patch({ fullName: "Olivia" })).status).toBe(403);
  });
});

describe("GET /api/settings/history and the server-side reads", () => {
  it("asks for the signed-in organization's history only", async () => {
    stub(() => json(200, { items: [], total: 0 }));
    const res = await history(request("GET", "/api/settings/history?organization_id=other"));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${ORG}/api/v1/tenant/settings/history?limit=25`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect((await history(request("GET", "/api/settings/history", undefined, { cookie: null as any }))).status).toBe(401);
  });

  it("getSettings maps the failures to reasons the page can explain", async () => {
    for (const [status, body, reason] of [[401, {}, "unauthorized"], [403, { detail: "x" }, "forbidden"], [403, { detail: { code: "setup_required" } }, "setup-required"], [500, {}, "unavailable"]] as const) {
      stub(() => json(status, body));
      expect(await getSettings(TOKEN)).toEqual({ ok: false, reason });
    }
    stub(() => null);
    expect(await getSettings(TOKEN)).toEqual({ ok: false, reason: "unavailable" });
    stub(() => json(200, { version: 1 }));
    expect(await getSettings(TOKEN)).toEqual({ ok: true, settings: { version: 1 } });
  });

  it("describeSettingsFailure never repeats raw server text for unexpected errors", () => {
    expect(describeSettingsFailure({ status: 500, data: { detail: "Traceback ..." } }).message).toBe("That could not be completed. Nothing was changed. Please try again.");
    expect(describeSettingsFailure(null).status).toBe(503);
  });
});
