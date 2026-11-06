// Server-side only. Fetches the signed-in administrator's OWN organization from the Organization Service.
//
// The request carries nothing but the tenant session token as a Bearer header: no organization id, no query
// string, no body. The Organization Service derives the organization from that token (via the Auth Service),
// so there is nothing for a browser or this app to tamper with. See docs/multi-tenancy.md.

export type TenantOrganization = {
  id: string;
  name: string;
  slug: string;
  country_code: string;
  tax_identifier: string | null;
  contact_email: string;
  is_active: boolean;
  created_at: string;
  // First-time setup (the Organization Service is the record): pending | in_progress | completed.
  setup_status?: "pending" | "in_progress" | "completed";
  has_logo?: boolean;
  logo_version?: string | null;
};

export type OrganizationResult =
  | { ok: true; organization: TenantOrganization }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };

export function orgServiceUrl(): string {
  return (process.env.ORG_SERVICE_URL || "http://localhost:8001").replace(/\/$/, "");
}

export async function fetchTenantOrganization(token: string): Promise<OrganizationResult> {
  try {
    const res = await fetch(`${orgServiceUrl()}/api/v1/tenant/organization`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, organization: (await res.json()) as TenantOrganization };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
