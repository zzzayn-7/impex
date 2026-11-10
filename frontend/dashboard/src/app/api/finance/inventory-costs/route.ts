import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { badParse, fail, isResponse, NO_STORE, parseCostBody, readObject, requireKey, sessionToken } from "@/lib/finance-routes";
import { inventoryRequest } from "@/lib/inventory";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const result = await financeRequest("GET", "/api/v1/finance/inventory-costs", token);
  if (!result || result.status !== 200) return financeFailureResponse(result);
  return NextResponse.json(result.data, { headers: NO_STORE });
}

// Record what stock already held (opening stock, stock given in kind) cost per unit. It changes no capital figure; it is the cost the next deliveries use.
// The product's SKU and name come from the Inventory Service (with the administrator's own session), never from the browser.
export async function POST(req: NextRequest) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  const key = requireKey(req);
  if (typeof key !== "string") return key;
  const body = await readObject(req);
  if (isResponse(body)) return body;
  const parsed = parseCostBody(body);
  if (!parsed.ok) return badParse(parsed);
  const product = await inventoryRequest("GET", `/api/v1/inventory/products/${parsed.value.product_id}`, token);
  if (!product || product.status !== 200 || typeof product.data?.sku !== "string") return fail(product && product.status === 404 ? "Product not found." : "The product could not be read. Please try again.", product && product.status === 404 ? 404 : 502);
  const result = await financeRequest("POST", "/api/v1/finance/inventory-costs", token, { ...parsed.value, sku: product.data.sku, name: product.data.name ?? product.data.sku }, { "Idempotency-Key": key });
  if (!result || (result.status !== 201 && result.status !== 200)) return financeFailureResponse(result);
  return NextResponse.json({ entry: result.data, replayed: result.status === 200 }, { status: result.status, headers: NO_STORE });
}
