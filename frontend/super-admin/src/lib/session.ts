// Constants/helpers that are safe to import from middleware (no next/headers).

export const SESSION_COOKIE = "impex_session";
export const SUPER_ADMIN_ROLE = "super-admin";

// The colour theme the server paints on the first byte: a CACHE of the Super Admin's saved choice (the Auth Service is the record). It is not a
// credential, and it is not the Organization portal's ("impex_tenant_theme"): the two portals share a host, so they must never share this cookie.
export const THEME_COOKIE = "impex_theme";

// Mark the cookie Secure whenever the original request came in over HTTPS
// (NGINX forwards the scheme in X-Forwarded-Proto). Plain http://localhost keeps working in dev.
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}
