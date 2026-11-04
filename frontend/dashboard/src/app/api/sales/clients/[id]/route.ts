import { NextRequest, NextResponse } from "next/server";

import { checkUuid, collapse, fail, isResponse, NO_STORE, readObject, sessionToken, text } from "@/lib/sales-routes";
import { salesFailureResponse, salesRequest } from "@/lib/sales";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FIELDS: [string, string, number][] = [["name", "name", 255], ["contactPerson", "contact_person", 255], ["email", "email", 320], ["phone", "phone", 50], ["address", "address", 500]];

// EDIT a client (only the fields that are sent). Clients are deactivated, never deleted.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = sessionToken(req);
  if (!token) return fail("You are not signed in.", 401);
  if (!checkUuid(params.id)) return fail("Client not found.", 404);
  const body = await readObject(req);
  if (isResponse(body)) return body;

  const change: Record<string, string> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [field, apiName, max] of FIELDS) {
    const value = text(body[field]);
    if (value === undefined) continue;
    const clean = field === "name" ? collapse(value) : value;
    if (field === "name" && !clean) fieldErrors.name = "Enter the client's name.";
    else if (clean.length > max) fieldErrors[field] = `Use ${max} characters or fewer.`;
    else if (field === "email" && clean && !EMAIL_RE.test(clean)) fieldErrors.email = "Enter a valid e-mail address.";
    change[apiName] = clean;
  }
  if (Object.keys(change).length === 0) return fail("Nothing to change.", 400);
  if (Object.keys(fieldErrors).length > 0) return fail("Please correct the highlighted fields.", 400, { fieldErrors });

  const result = await salesRequest("PATCH", `/api/v1/sales/clients/${params.id}`, token, change);
  if (result?.status === 409 && typeof result.data?.detail === "string") return fail(result.data.detail, 409, { fieldErrors: { name: result.data.detail } });
  if (!result || result.status !== 200) return salesFailureResponse(result, "Client not found.");
  return NextResponse.json({ client: result.data }, { headers: NO_STORE });
}
