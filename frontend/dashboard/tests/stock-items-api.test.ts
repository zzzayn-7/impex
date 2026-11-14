import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/stock/items/route";

// GET /api/stock/items: one more page of the Stock list for the scrolling list. Read-only, the administrator's own session, no organization anywhere.

const TOKEN = "tenant-session-token";
const INVENTORY = "http://inventory-service:8002";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
const stub = (handler: (url: string) => Response) => {
  fetchMock = vi.fn(async (url: any) => handler(String(url)));
  vi.stubGlobal("fetch", fetchMock);
};
const get = (query: string, cookie: string | null = `impex_tenant_session=${TOKEN}`) =>
  GET(new NextRequest(`http://localhost:3001/api/stock/items${query}`, { method: "GET", headers: cookie ? { cookie } : {} }));

beforeEach(() => {
  process.env.INVENTORY_SERVICE_URL = INVENTORY;
  stub(() => json(200, { items: [{ product_id: "p1" }], total: 60, limit: 25, offset: 25 }));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/stock/items", () => {
  it("needs the tenant session and never calls the service without one", async () => {
    expect((await get("?page=2", null)).status).toBe(401);
    expect((await get("?page=2", "impex_session=super-admin-token")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the Inventory Service for the requested page with the whitelisted filters only", async () => {
    const res = await get("?page=3&q=bolt&status=archived&organization_id=evil&in_stock_only=true&limit=999");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ product_id: "p1" }], total: 60, pageSize: 25 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/v1/inventory/stock");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "bolt", status: "archived", limit: "25", offset: "50" });
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to page 1 and active products for anything unexpected", async () => {
    await get("?page=-4&status=deleted");
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[0][0] as string).searchParams)).toEqual({ status: "active", limit: "25", offset: "0" });
  });

  it("answers with a plain status when the service refuses or is down", async () => {
    stub(() => json(403, { detail: "inactive" }));
    expect((await get("?page=2")).status).toBe(403);
    stub(() => json(401, { detail: "expired" }));
    expect((await get("?page=2")).status).toBe(401);
    stub(() => { throw new Error("down"); });
    expect((await get("?page=2")).status).toBe(503);
  });
});
