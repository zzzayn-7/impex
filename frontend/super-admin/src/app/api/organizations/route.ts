import { NextRequest, NextResponse } from "next/server";

import { describeFailure, inviteAdministrator } from "@/lib/administrators";
import { getSessionToken } from "@/lib/auth";
import {
  FieldErrors,
  OrganizationInput,
  normalizeOrganizationInput,
  validateOrganization,
} from "@/lib/organization-validation";
import { orgServiceUrl } from "@/lib/organizations";
import { slugCandidates, slugify } from "@/lib/slug";

export const dynamic = "force-dynamic";

function fail(error: string, status: number, fieldErrors?: FieldErrors) {
  return NextResponse.json({ error, fieldErrors }, { status });
}

// Maps the Organization Service's field names (snake_case) back to the form's field names.
const API_TO_FORM_FIELD: Record<string, keyof OrganizationInput> = {
  name: "name",
  primary_admin_email: "primaryAdminEmail",
  contact_email: "contactEmail",
  country_code: "countryCode",
  tax_identifier: "taxIdentifier",
};

function fieldErrorsFromApi(detail: unknown): FieldErrors {
  const errors: FieldErrors = {};
  if (!Array.isArray(detail)) return errors;
  for (const item of detail as { loc?: unknown[]; msg?: string }[]) {
    const field = API_TO_FORM_FIELD[String(item.loc?.[item.loc.length - 1])];
    if (field && !errors[field]) errors[field] = item.msg ?? "Invalid value.";
  }
  return errors;
}

// Optional first-administrator invitation. The organization already exists at this point, so a failure here
// (for example the mail server being down) is reported as a warning and never undoes the registration.
// Nothing is stored when the email fails, so retrying with "Add Administrator" cannot create duplicates.
async function sendFirstInvitation(token: string, organizationId: string, email: string) {
  const result = await inviteAdministrator(token, organizationId, email);
  if (result && result.status === 201) return { sent: true, email };
  return { sent: false, email, message: describeFailure(result).message };
}

export async function POST(req: NextRequest) {
  // 1. Must have a session. The Organization Service independently verifies the token and the
  //    super-admin role on every call, so a forged or non-admin cookie is rejected there too.
  const token = getSessionToken();
  if (!token) return fail("You are not signed in.", 401);

  if (!req.headers.get("content-type")?.includes("application/json")) {
    return fail("Invalid request.", 415);
  }

  // 2. Validate
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid request.", 400);
  }
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const input = normalizeOrganizationInput({
    name: str(body.name),
    primaryAdminEmail: str(body.primaryAdminEmail),
    contactEmail: str(body.contactEmail),
    countryCode: str(body.countryCode),
    taxIdentifier: str(body.taxIdentifier),
  });
  const fieldErrors = validateOrganization(input);
  if (Object.keys(fieldErrors).length > 0) {
    return fail("Please correct the highlighted fields.", 400, fieldErrors);
  }

  // 3. Create. The slug is generated from the name; on a slug conflict (409) try the next candidate.
  for (const slug of slugCandidates(slugify(input.name))) {
    let res: Response;
    try {
      res = await fetch(`${orgServiceUrl()}/api/v1/organizations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: input.name,
          slug,
          country_code: input.countryCode,
          tax_identifier: input.taxIdentifier || null,
          contact_email: input.contactEmail,
          primary_admin_email: input.primaryAdminEmail,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return fail("The organization service is unavailable. Please try again shortly.", 503);
    }

    if (res.status === 201) {
      const organization = await res.json();
      const invitation =
        body.sendInvitation === true ? await sendFirstInvitation(token, organization.id, input.primaryAdminEmail) : null;
      return NextResponse.json({ ...organization, invitation }, { status: 201 });
    }
    if (res.status === 409) continue; // slug taken: try the next candidate
    if (res.status === 401) return fail("Your session has expired. Please sign in again.", 401);
    if (res.status === 403) return fail("You do not have permission to manage organizations.", 403);
    if (res.status === 422) {
      const detail = (await res.json().catch(() => null))?.detail;
      const apiErrors = fieldErrorsFromApi(detail);
      return fail("Some values were rejected. Please check the form.", 400, apiErrors);
    }
    if (res.status === 503) return fail("The organization service is unavailable. Please try again shortly.", 503);
    return fail("Could not create the organization. Please try again.", 502);
  }

  return fail("Could not generate a unique identifier for this name. Try a slightly different name.", 409);
}
