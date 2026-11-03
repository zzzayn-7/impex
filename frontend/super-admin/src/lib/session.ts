// Constants/helpers that are safe to import from middleware (no next/headers).

export const SESSION_COOKIE = "impex_session";
export const SUPER_ADMIN_ROLE = "super-admin";

// Mark the cookie Secure whenever the original request came in over HTTPS
// (NGINX forwards the scheme in X-Forwarded-Proto). Plain http://localhost keeps working in dev.
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}
