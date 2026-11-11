import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, PUT } from "@/app/api/profile/avatar/route";

const AUTH = "http://auth-service:8000";
const TOKEN = "session-token-abc";
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string, init: any) => Response) => {
  fetchMock = vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
};
const upstream = () => ({ url: fetchMock.mock.calls[0][0] as string, init: fetchMock.mock.calls[0][1] as any });
const cookie = `impex_tenant_session=${TOKEN}`;
const get = (signedIn = true) => new NextRequest("http://localhost:3001/api/profile/avatar?v=1&id=someone-else", { method: "GET", headers: signedIn ? { cookie } : {} });
const del = (signedIn = true) => new NextRequest("http://localhost:3001/api/profile/avatar", { method: "DELETE", headers: signedIn ? { cookie } : {} });
const put = (file: File | string | null, signedIn = true) => {
  const form = new FormData();
  if (file !== null) form.set("file", file as any);
  return new NextRequest("http://localhost:3001/api/profile/avatar", { method: "PUT", headers: signedIn ? { cookie } : {}, body: form });
};
const png = (type = "image/png", size = 100) => new File([new Uint8Array(size)], "x.png", { type });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = AUTH;
  stub(() => json(200, {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET: only the signed-in administrator's own picture", () => {
  it("needs a session and never forwards anything the browser put in the address", async () => {
    expect((await GET(get(false))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    stub(() => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "image/png" } }));
    const res = await GET(get());
    expect(upstream().url).toBe(`${AUTH}/api/v1/auth/me/avatar`); // no id, no query: who it is comes from the token alone
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
  });
  it.each([[404, 404], [401, 401], [500, 503]])("maps an upstream %i to %i", async (from, to) => {
    stub(() => json(from, {}));
    expect((await GET(get())).status).toBe(to);
  });
  it("says it is unavailable when the Auth Service cannot be reached", async () => {
    stub(() => { throw new Error("down"); });
    expect((await GET(get())).status).toBe(503);
  });
});

describe("PUT: add or replace", () => {
  it("needs a session and a multipart file", async () => {
    expect((await PUT(put(png(), false))).status).toBe(401);
    expect((await PUT(put(null))).status).toBe(400);
    expect((await PUT(put("not a file"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses a wrong type and an oversize file before anything is sent", async () => {
    expect((await PUT(put(png("image/gif")))).status).toBe(400);
    expect((await PUT(put(png("image/png", 2 * 1024 * 1024 + 1)))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("passes exactly one file to the Auth Service with the person's own token, and returns only the picture's state", async () => {
    stub(() => json(200, { id: "u", email: "secret@x.y", has_avatar: true, avatar_version: "123" }));
    const res = await PUT(put(png("image/jpeg")));
    expect(upstream().url).toBe(`${AUTH}/api/v1/auth/me/avatar`);
    expect(upstream().init.method).toBe("PUT");
    expect([...(upstream().init.body as FormData).keys()]).toEqual(["file"]);
    expect(upstream().init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(await res.json()).toEqual({ has_avatar: true, avatar_version: "123" });
  });
  it("shows the service's reason when it refuses the picture", async () => {
    stub(() => json(422, { detail: { code: "too_small", message: "The picture must be at least 64 x 64 pixels." } }));
    const res = await PUT(put(png()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The picture must be at least 64 x 64 pixels.");
  });
  it("maps an expired session and an outage", async () => {
    stub(() => json(401, {}));
    expect((await PUT(put(png()))).status).toBe(401);
    stub(() => { throw new Error("down"); });
    expect((await PUT(put(png()))).status).toBe(503);
  });
});

describe("DELETE: remove", () => {
  it("needs a session, then removes the caller's own picture", async () => {
    expect((await DEL(false)).status).toBe(401);
    stub(() => json(200, { has_avatar: false }));
    const res = await DEL(true);
    expect(upstream().init.method).toBe("DELETE");
    expect(upstream().url).toBe(`${AUTH}/api/v1/auth/me/avatar`);
    expect(await res.json()).toEqual({ has_avatar: false, avatar_version: null });
  });
});

const DEL = (signedIn: boolean) => DELETE(del(signedIn));
