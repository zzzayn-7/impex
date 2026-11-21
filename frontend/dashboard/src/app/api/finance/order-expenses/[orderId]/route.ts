import { NextRequest, NextResponse } from "next/server";

import { financeFailureResponse, financeRequest } from "@/lib/finance";
import { checkMoney, checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken } from "@/lib/finance-routes";
import { MAX_OTHER_EXPENSES } from "@/lib/pnl";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

// SAVE what was spent on one order (Finance > PNL Calculator). The browser sends only the amounts it typed: the cost of the goods, the delivery charges and any other expenses
// with their names. Which order it is and its CURRENCY come from the Sales Service (read with the administrator's own session), so another organization's order, or one that does
// not exist, is "not found" and nothing is saved. The selling price is never sent or stored: it is the order's own total. This is a calculator: nothing is posted to the books.
export async function PUT(req: NextRequest, { params }: { params: { orderId: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.orderId)) return fail("Order not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const blank = (value: unknown) => (value === undefined || value === null || value === "" ? "0" : checkMoney(value, true));
  const goods = blank(body.goodsCost);
  if (goods === null) return fail("Enter the cost of the goods as an amount (at most 4 decimals).", 400);
  const delivery = blank(body.deliveryCharges);
  if (delivery === null) return fail("Enter the delivery charges as an amount (at most 4 decimals).", 400);
  const rawOthers = body.otherExpenses === undefined ? [] : body.otherExpenses;
  if (!Array.isArray(rawOthers)) return fail("Send the other expenses as a list.", 400);
  if (rawOthers.length > MAX_OTHER_EXPENSES) return fail(`You can add at most ${MAX_OTHER_EXPENSES} other expenses.`, 400);
  const others: { label: string; amount: string }[] = [];
  for (const entry of rawOthers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("Invalid expense.", 400);
    const label = collapse(typeof (entry as any).label === "string" ? (entry as any).label : "").trim();
    if (!label) return fail("Give every expense a name.", 400);
    if (label.length > 60) return fail("Use 60 characters or fewer for an expense name.", 400);
    const amount = blank((entry as any).amount);
    if (amount === null) return fail(`Enter the amount of "${label}" (at most 4 decimals).`, 400);
    others.push({ label, amount });
  }

  const order = await salesRequest("GET", `/api/v1/sales/orders/${params.orderId}`, token);
  if (!order || order.status !== 200) return salesFailureResponse(order, "Order not found.");
  const currency = order.data?.currency_code;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return fail("This order has no prices, so its profit cannot be worked out.", 400);

  const saved = await financeRequest("PUT", `/api/v1/finance/order-expenses/${params.orderId}`, token, { currency_code: currency, goods_cost: goods, delivery_charges: delivery, other_expenses: others });
  if (!saved || saved.status !== 200) return financeFailureResponse(saved);
  return NextResponse.json({ expenses: saved.data }, { headers: NO_STORE });
}

// DELETE what was saved for one order: it goes back to "not calculated". Only this calculator's notes are removed: never the order, and nothing in the books. Whose notes they are comes from
// the session (another organization's id is simply "not found").
export async function DELETE(req: NextRequest, { params }: { params: { orderId: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.orderId)) return fail("Order not found.", 404);
  const result = await financeRequest("DELETE", `/api/v1/finance/order-expenses/${params.orderId}`, token);
  if (!result || result.status !== 204) return financeFailureResponse(result, "There are no saved expenses for this order.");
  return NextResponse.json({ deleted: true }, { headers: NO_STORE });
}
