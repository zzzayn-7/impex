// Constants/helpers safe to import from middleware (no next/headers).

// Deliberately different from the Super Admin portal's cookie ("impex_session"): the two portals never
// read, accept or issue each other's session.
export const TENANT_SESSION_COOKIE = "impex_tenant_session";
export const ORGANIZATION_ADMIN_ROLE = "organization-admin";

// Mark the cookie Secure whenever the original request came in over HTTPS (proxies forward the scheme
// in X-Forwarded-Proto). Plain http://localhost keeps working in development.
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}
