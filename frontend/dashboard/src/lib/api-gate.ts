import { canUse, moduleForApi } from "@/lib/modules";
import { setupNeed } from "@/lib/onboarding";
import { orgServiceUrl } from "@/lib/organization";
import { authServiceUrl } from "@/lib/tenant-auth";

// THE RULES behind the business API gate (see middleware.ts for why they exist): before an organization administrator may use a business route
// (products, stock, scan, sales, purchasing, finance), first-time setup must be complete and the route's module must be enabled for the organization.
// Nothing is decided here that the services behind do not enforce again; this only stops the request early, with a clear reason.
//
// It is a plain function of the session token and the path, so it can run in two places:
//   * in the middleware itself (local development, Docker: the services are reachable from there), or
//   * in the /api/gate route handler (Vercel: a service binding resolves only inside functions, never in middleware, so the middleware asks that route).
// Both give exactly the same answer: `null` = let the request through, otherwise the refusal to send.

export type GateRefusal = { status: number; body: Record<string, unknown> };

const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}): GateRefusal => ({ status, body: { error, code, ...extra } });

async function get(url: string, token: string): Promise<{ status: number; data: any } | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    return { status: res.status, data: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return null;
  }
}

export async function decideGate(token: string, pathname: string): Promise<GateRefusal | null> {
  const me = await get(`${authServiceUrl()}/api/v1/auth/me`, token);
  if (!me || (me.status !== 200 && me.status !== 401)) return refuse(503, "We could not check your account setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (me.status === 401 || !me.data || me.data.role !== "organization-admin") return null; // the route and the services refuse them
  const org = await get(`${orgServiceUrl()}/api/v1/tenant/organization`, token);
  if (!org) return refuse(503, "We could not check your organization setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (org.status === 401 || org.status === 403) return null; // an inactive organization is refused by the services
  if (org.status !== 200 || !org.data) return refuse(503, "We could not check your organization setup right now. Please try again in a moment.", "setup_check_unavailable");
  if (setupNeed(me.data, org.data).required) return refuse(403, "Finish the first-time setup before using this part of Impex.", "setup_required");
  // MODULES: the route's module must be enabled for the organization (the Organization Service's list, read with the caller's own token).
  // A list that is missing or malformed is an outage of that decision, not a "yes". The services behind enforce the same rule again.
  const module = moduleForApi(pathname);
  if (module) {
    if (!Array.isArray(org.data.modules)) return refuse(503, "We could not check which modules your organization can use right now. Please try again in a moment.", "module_check_unavailable");
    if (!canUse(org.data.modules, module)) return refuse(403, "This part of Impex is not enabled for your organization.", "module_disabled", { module });
  }
  return null;
}

/** The refusal used when the gate itself cannot be asked (fail closed: never "assume allowed"). */
export const gateUnavailable = (): GateRefusal => refuse(503, "We could not check your account setup right now. Please try again in a moment.", "setup_check_unavailable");
