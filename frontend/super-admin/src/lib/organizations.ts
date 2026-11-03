import type { Organization } from "@/lib/organization-validation";

// Server-side only. Inside Docker this is the organization-service container; set in docker-compose.yml.
export function orgServiceUrl(): string {
  return (process.env.ORG_SERVICE_URL || "http://localhost:8001").replace(/\/$/, "");
}

export type OrganizationList =
  | { ok: true; organizations: Organization[] }
  | { ok: false; reason: "unauthorized" | "forbidden" | "unavailable" };

// Reads organizations from the Organization Service (which reads PostgreSQL),
// authenticating with the Super Admin's token.
export async function listOrganizations(token: string): Promise<OrganizationList> {
  try {
    const res = await fetch(`${orgServiceUrl()}/api/v1/organizations`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return { ok: true, organizations: (await res.json()) as Organization[] };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
