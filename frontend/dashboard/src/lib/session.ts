// Constants/helpers safe to import from middleware (no next/headers).

// Deliberately different from the Super Admin portal's cookie ("impex_session"): the two portals never
// read, accept or issue each other's session.
export const TENANT_SESSION_COOKIE = "impex_tenant_session";
export const ORGANIZATION_ADMIN_ROLE = "organization-admin";

// The colour theme the server paints on the first byte: a CACHE of the administrator's saved choice (the Auth Service is the record). It is not a
// credential, and it is not the Super Admin portal's (that one is "impex_theme"): the two portals share a host, so they must never share this cookie.
export const THEME_COOKIE = "impex_tenant_theme";

// Mark the cookie Secure whenever the original request came in over HTTPS (proxies forward the scheme
// in X-Forwarded-Proto). Plain http://localhost keeps working in development.
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}
