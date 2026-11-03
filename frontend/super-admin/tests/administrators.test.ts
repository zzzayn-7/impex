import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A mutable cookie jar standing in for the incoming request's cookies.
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));

import { POST as addAdministrator } from "@/app/api/administrators/route";
import { POST as resendInvitation } from "@/app/api/administrators/[id]/resend/route";
import { DELETE as deleteAdministrator, PATCH as editAdministrator } from "@/app/api/administrators/[id]/route";
import { POST as createOrganization } from "@/app/api/organizations/route";
import { POST as lookup } from "@/app/api/activate/lookup/route";
import { listAdministrators } from "@/lib/administrators";

const ORG = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
const ADMIN_ID = "9a1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f7";
const TOKEN = "super-admin-session-token";

const administrator = {
  id: ADMIN_ID, organization_id: ORG, organization_name: "Acme Imports", organization_slug: "acme", full_name: "Ada Lovelace",
  email: "ada@example.org", role: "organization-admin", status: "pending",
  invited_at: "2026-11-04T10:00:00+00:00", expires_at: "2026-11-05T10:00:00+00:00", activated_at: null,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (url: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new NextRequest(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const addRequest = (body: unknown, headers?: Record<string, string>) => post("http://localhost:3000/api/administrators", body, headers);
const validBody = { organizationId: ORG, fullName: "Ada Lovelace", email: "ada@example.org" };

let fetchMock: ReturnType<typeof vi.fn>;
const stubOrgService = (handler: (url: string, init: any) => Response | Promise<Response>) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};

beforeEach(() => {
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  jar["impex_session"] = TOKEN;
  stubOrgService(() => json(201, administrator));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/administrators", () => {
  it("requires a Super Admin session and never contacts the backend without one", async () => {
    delete jar["impex_session"];
    const res = await addAdministrator(addRequest(validBody));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores the organization portal's cookie", async () => {
    delete jar["impex_session"];
    jar["impex_tenant_session"] = "tenant-token";
    expect((await addAdministrator(addRequest(validBody))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-JSON requests", async () => {
    expect((await addAdministrator(addRequest("x=1", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await addAdministrator(addRequest("{broken"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no organization", { ...validBody, organizationId: "" }, "organizationId"],
    ["an organization id that is not a UUID", { ...validBody, organizationId: "acme" }, "organizationId"],
    ["a missing name", { ...validBody, fullName: "" }, "fullName"],
    ["a one-letter name", { ...validBody, fullName: "A" }, "fullName"],
    ["an invalid email", { ...validBody, email: "not-an-email" }, "email"],
    ["a missing email", { organizationId: ORG, fullName: "Ada Lovelace" }, "email"],
  ])("rejects %s without calling the backend", async (_label, body, field) => {
    const res = await addAdministrator(addRequest(body));
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).fieldErrors)).toContain(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the organization, name and email, using the Super Admin's own token", async () => {
    const res = await addAdministrator(addRequest({ organizationId: ORG, fullName: "  Ada   Lovelace ", email: "  Ada@Example.ORG " }));
    expect(res.status).toBe(201);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/administrators`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ email: "ada@example.org", full_name: "Ada Lovelace" });
  });

  it("cannot be used to assign a role, another organization or an account state", async () => {
    await addAdministrator(addRequest({
      ...validBody, role: "super-admin", organization_id: "00000000-0000-4000-8000-000000000000",
      is_active: false, token: "x", password: "Secret!Pass1",
    }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(ORG); // the organization the Super Admin selected, not the injected one
    expect(JSON.parse(init.body)).toEqual({ email: "ada@example.org", full_name: "Ada Lovelace" });
    expect(init.body).not.toContain("super-admin");
    expect(init.body).not.toContain("Secret!Pass1");
  });

  it("returns the administrator record and never the session token or any service secret", async () => {
    process.env.ORG_ACTIVATION_API_KEY = "activation-secret";
    const text = await (await addAdministrator(addRequest(validBody))).text();
    expect(JSON.parse(text).administrator.email).toBe("ada@example.org");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("activation-secret");
    expect(text).not.toMatch(/token_hash|password/i);
  });

  it.each([
    [401, { detail: "Missing, invalid or expired token" }, 401, "session has expired"],
    [403, { detail: "Super Admin permission required" }, 403, "do not have permission"],
    [404, { detail: "Organization 'x' not found." }, 404, "not found"],
    [409, { detail: "This email address already belongs to another account." }, 409, "already belongs to another account"],
    [409, { detail: "An active invitation already exists. Use resend to replace it." }, 409, "Use resend"],
    [422, { detail: [{ loc: ["body", "email"], msg: "bad" }] }, 400, "check the administrator"],
    [502, { detail: "The invitation email could not be sent. Nothing was changed; please try again." }, 502, "could not be sent"],
    [503, { detail: "The account service is temporarily unavailable. Please try again in a moment." }, 503, "temporarily unavailable"],
    [500, { detail: "internal stack trace" }, 502, "could not be completed"],
  ])("maps a %i answer from the backend to a safe %i message", async (backendStatus, body, expectedStatus, fragment) => {
    stubOrgService(() => json(backendStatus, body));
    const res = await addAdministrator(addRequest(validBody));
    expect(res.status).toBe(expectedStatus);
    const { error } = await res.json();
    expect(error).toContain(fragment);
    expect(error).not.toContain("stack trace");
  });

  it("answers 503 when the Organization Service cannot be reached", async () => {
    stubOrgService(() => {
      throw new Error("ECONNREFUSED");
    });
    expect((await addAdministrator(addRequest(validBody))).status).toBe(503);
  });
});

describe("POST /api/administrators/[id]/resend", () => {
  const resendRequest = (body: unknown, headers?: Record<string, string>) =>
    post(`http://localhost:3000/api/administrators/${ADMIN_ID}/resend`, body, headers);
  const ctx = (id = ADMIN_ID) => ({ params: { id } });

  it("requires a session", async () => {
    delete jar["impex_session"];
    expect((await resendInvitation(resendRequest({ organizationId: ORG }), ctx())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the ids before calling the backend", async () => {
    expect((await resendInvitation(resendRequest({ organizationId: ORG }), ctx("not-a-uuid"))).status).toBe(404);
    expect((await resendInvitation(resendRequest({ organizationId: "nope" }), ctx())).status).toBe(400);
    expect((await resendInvitation(resendRequest({}), ctx())).status).toBe(400);
    expect((await resendInvitation(resendRequest("x", { "content-type": "text/plain" }), ctx())).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the backend to resend within the named organization, as the Super Admin", async () => {
    const res = await resendInvitation(resendRequest({ organizationId: ORG, role: "super-admin" }), ctx());
    expect(res.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/administrators/${ADMIN_ID}/resend`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined(); // nothing from the browser is forwarded
    expect((await res.json()).administrator.status).toBe("pending");
  });

  it("passes backend refusals through safely (wrong organization, already active)", async () => {
    stubOrgService(() => json(404, { detail: "Administrator not found for this organization." }));
    expect((await resendInvitation(resendRequest({ organizationId: ORG }), ctx())).status).toBe(404);
    stubOrgService(() => json(409, { detail: "This administrator has already activated their account." }));
    const res = await resendInvitation(resendRequest({ organizationId: ORG }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already activated");
  });
});

describe("registering an organization with an automatic first invitation", () => {
  const orgBody = (extra: Record<string, unknown> = {}) => ({
    name: "Acme Imports", primaryAdminEmail: "Owner@Acme.example", contactEmail: "ops@acme.example", countryCode: "de",
    taxIdentifier: "", ...extra,
  });
  const orgRequest = (body: unknown) => post("http://localhost:3000/api/organizations", body);
  const organization = { id: ORG, name: "Acme Imports", slug: "acme-imports", country_code: "DE", primary_admin_email: "owner@acme.example", is_active: true };

  const stub = (inviteResponse: () => Response) =>
    stubOrgService((url) => (url.endsWith("/administrators") ? inviteResponse() : json(201, organization)));

  it("emails the primary administrator after the organization is created", async () => {
    stub(() => json(201, administrator));
    const res = await createOrganization(orgRequest(orgBody({ sendInvitation: true })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("acme-imports");
    expect(body.invitation).toEqual({ sent: true, email: "owner@acme.example" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [inviteUrl, inviteInit] = fetchMock.mock.calls[1];
    expect(inviteUrl).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/administrators`);
    expect(inviteInit.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(inviteInit.body)).toEqual({ email: "owner@acme.example" }); // no role, no organization in the body
  });

  it("keeps the organization and reports a warning when the email cannot be sent", async () => {
    stub(() => json(502, { detail: "The invitation email could not be sent. Nothing was changed; please try again." }));
    const res = await createOrganization(orgRequest(orgBody({ sendInvitation: true })));
    expect(res.status).toBe(201); // the organization exists
    const body = await res.json();
    expect(body.slug).toBe("acme-imports");
    expect(body.invitation.sent).toBe(false);
    expect(body.invitation.message).toContain("could not be sent");
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one attempt: nothing is retried, so nothing is duplicated
  });

  it("reports a warning when the Organization Service is unreachable for the invitation", async () => {
    stubOrgService((url) => {
      if (url.endsWith("/administrators")) throw new Error("ECONNREFUSED");
      return json(201, organization);
    });
    const body = await (await createOrganization(orgRequest(orgBody({ sendInvitation: true })))).json();
    expect(body.invitation.sent).toBe(false);
  });

  it("sends no invitation unless asked to", async () => {
    stub(() => json(201, administrator));
    for (const extra of [{}, { sendInvitation: false }, { sendInvitation: "yes" }]) {
      fetchMock.mockClear();
      const body = await (await createOrganization(orgRequest(orgBody(extra)))).json();
      expect(body.invitation).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("does nothing when the organization details are invalid", async () => {
    const res = await createOrganization(orgRequest(orgBody({ primaryAdminEmail: "nope", sendInvitation: true })));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listAdministrators", () => {
  it("returns the administrators with the Super Admin's token", async () => {
    stubOrgService(() => json(200, [administrator]));
    const result = await listAdministrators(TOKEN);
    expect(result).toEqual({ ok: true, administrators: [administrator] });
    expect(fetchMock.mock.calls[0][0]).toBe("http://organization-service:8001/api/v1/organizations/administrators");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("distinguishes an expired session, missing permission and an outage", async () => {
    stubOrgService(() => json(401, {}));
    expect(await listAdministrators(TOKEN)).toEqual({ ok: false, reason: "unauthorized" });
    stubOrgService(() => json(403, {}));
    expect(await listAdministrators(TOKEN)).toEqual({ ok: false, reason: "forbidden" });
    stubOrgService(() => json(500, {}));
    expect(await listAdministrators(TOKEN)).toEqual({ ok: false, reason: "unavailable" });
    stubOrgService(() => {
      throw new Error("down");
    });
    expect(await listAdministrators(TOKEN)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("activation page prefill", () => {
  const lookupRequest = () => post("http://localhost:3000/api/activate/lookup", { token: "A".repeat(43) });

  beforeEach(() => {
    process.env.ORG_ACTIVATION_API_KEY = "test-key";
  });

  it("passes on the name the Super Admin entered, without any ids", async () => {
    stubOrgService(() => json(200, { organization_name: "Acme Imports", email: "ada@example.org", full_name: "Ada Lovelace", expires_at: "2026-11-05T10:00:00+00:00" }));
    const body = await (await lookup(lookupRequest())).json();
    expect(body).toEqual({ organizationName: "Acme Imports", email: "ada@example.org", fullName: "Ada Lovelace", expiresAt: "2026-11-05T10:00:00+00:00" });
  });

  it("returns a null name for invitations that carry none", async () => {
    stubOrgService(() => json(200, { organization_name: "Acme", email: "a@b.org", full_name: null, expires_at: "x" }));
    expect((await (await lookup(lookupRequest())).json()).fullName).toBeNull();
  });
});


describe("PATCH /api/administrators/[id] (edit)", () => {
  const ctx = (id = ADMIN_ID) => ({ params: { id } });
  const patchRequest = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    new NextRequest(`http://localhost:3000/api/administrators/${ADMIN_ID}`, {
      method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeEach(() => {
    stubOrgService(() => json(200, { ...administrator, full_name: "Ada King" }));
  });

  it("requires a session and valid input before contacting the backend", async () => {
    delete jar["impex_session"];
    expect((await editAdministrator(patchRequest({ organizationId: ORG, fullName: "Ada King" }), ctx())).status).toBe(401);
    jar["impex_session"] = TOKEN;
    expect((await editAdministrator(patchRequest("x", { "content-type": "text/plain" }), ctx())).status).toBe(415);
    expect((await editAdministrator(patchRequest({ organizationId: ORG, fullName: "Ada King" }), ctx("nope"))).status).toBe(404);
    expect((await editAdministrator(patchRequest({ organizationId: "nope", fullName: "Ada King" }), ctx())).status).toBe(400);
    expect((await editAdministrator(patchRequest({ organizationId: ORG }), ctx())).status).toBe(400); // nothing to change
    const badName = await editAdministrator(patchRequest({ organizationId: ORG, fullName: "A" }), ctx());
    expect((await badName.json()).fieldErrors).toHaveProperty("fullName");
    const badEmail = await editAdministrator(patchRequest({ organizationId: ORG, email: "nope" }), ctx());
    expect((await badEmail.json()).fieldErrors).toHaveProperty("email");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the changed name/email, as the Super Admin, and nothing privileged", async () => {
    const res = await editAdministrator(
      patchRequest({ organizationId: ORG, fullName: "  Ada   King ", email: " ADA.KING@Example.org ", role: "super-admin", organization_id: "x", is_active: false }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect((await res.json()).administrator.full_name).toBe("Ada King");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/administrators/${ADMIN_ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ full_name: "Ada King", email: "ada.king@example.org" });
  });

  it("can change just one field", async () => {
    await editAdministrator(patchRequest({ organizationId: ORG, fullName: "Ada King" }), ctx());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ full_name: "Ada King" });
  });

  it.each([
    [409, { detail: "This email address already belongs to another account." }, 409, "another account"],
    [404, { detail: "Administrator not found for this organization." }, 404, "not found"],
    [502, { detail: "The invitation email could not be sent (x). Nothing was changed; please try again." }, 502, "could not be sent"],
    [503, { detail: "The account service is temporarily unavailable. Please try again in a moment." }, 503, "temporarily unavailable"],
    [422, { detail: "Provide a name or an email to change." }, 400, "name or an email"],
    [401, { detail: "x" }, 401, "session has expired"],
  ])("maps a %i from the backend to a safe %i", async (backendStatus, body, expectedStatus, fragment) => {
    stubOrgService(() => json(backendStatus, body));
    const res = await editAdministrator(patchRequest({ organizationId: ORG, fullName: "Ada King" }), ctx());
    expect(res.status).toBe(expectedStatus);
    expect((await res.json()).error).toContain(fragment);
  });
});

describe("DELETE /api/administrators/[id]", () => {
  const ctx = (id = ADMIN_ID) => ({ params: { id } });
  const deleteRequest = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    new NextRequest(`http://localhost:3000/api/administrators/${ADMIN_ID}`, {
      method: "DELETE", headers, body: typeof body === "string" ? body : JSON.stringify(body),
    });

  beforeEach(() => {
    stubOrgService(() => new Response(null, { status: 204 }));
  });

  it("requires a session and valid ids", async () => {
    delete jar["impex_session"];
    expect((await deleteAdministrator(deleteRequest({ organizationId: ORG }), ctx())).status).toBe(401);
    jar["impex_session"] = TOKEN;
    expect((await deleteAdministrator(deleteRequest("x", { "content-type": "text/plain" }), ctx())).status).toBe(415);
    expect((await deleteAdministrator(deleteRequest({ organizationId: ORG }), ctx("nope"))).status).toBe(404);
    expect((await deleteAdministrator(deleteRequest({ organizationId: "nope" }), ctx())).status).toBe(400);
    expect((await deleteAdministrator(deleteRequest({}), ctx())).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes within the named organization as the Super Admin, forwarding nothing from the browser", async () => {
    const res = await deleteAdministrator(deleteRequest({ organizationId: ORG, role: "super-admin" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://organization-service:8001/api/v1/organizations/${ORG}/administrators/${ADMIN_ID}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it("passes backend refusals through safely, and reports an outage", async () => {
    stubOrgService(() => json(404, { detail: "Administrator not found for this organization." }));
    expect((await deleteAdministrator(deleteRequest({ organizationId: ORG }), ctx())).status).toBe(404);
    stubOrgService(() => json(503, { detail: "The account service is temporarily unavailable. Please try again in a moment." }));
    expect((await deleteAdministrator(deleteRequest({ organizationId: ORG }), ctx())).status).toBe(503);
    stubOrgService(() => {
      throw new Error("ECONNREFUSED");
    });
    expect((await deleteAdministrator(deleteRequest({ organizationId: ORG }), ctx())).status).toBe(503);
  });
});
