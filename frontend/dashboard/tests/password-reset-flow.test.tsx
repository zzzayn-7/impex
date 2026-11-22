// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => router,
}));

import { POST as changePassword } from "@/app/api/auth/change-password/route";
import { POST as signIn } from "@/app/api/auth/login/route";
import ChangePasswordForm from "@/app/change-password/change-password-form";
import LoginForm from "@/app/login/login-form";
import { passwordChecks, passwordIsStrong } from "@/lib/password-policy";
import { TENANT_SESSION_COOKIE } from "@/lib/session";
import { loadWorkspace } from "@/lib/tenant-session";
import { orgAdmin } from "./helpers";

// After the Super Admin resets an administrator's password: the temporary password signs in, the portal sends the person to choose their own before anything else, and the Auth Service decides.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const user = () => userEvent.setup();
const STRONG = "An0ther!Passphrase9";

beforeEach(() => {
  process.env.AUTH_SERVICE_URL = "http://auth-service:8000";
  process.env.ORG_SERVICE_URL = "http://organization-service:8001";
  for (const key of Object.keys(jar)) delete jar[key];
  router.replace.mockReset();
  router.refresh.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the password rules shown while typing", () => {
  it("are the Auth Service's own rules", () => {
    const ids = (password: string) => passwordChecks(password, "ada@example.org").filter((c) => !c.ok).map((c) => c.id);
    expect(ids("")).toEqual(["length", "lower", "upper", "digit", "symbol"]);
    expect(ids("short")).toEqual(["length", "upper", "digit", "symbol"]);
    expect(ids("alllowercase123!")).toEqual(["upper"]);
    expect(ids("NoSymbols12345Aa")).toEqual(["symbol"]);
    expect(ids("Ada!Passphrase99")).toEqual(["email"]); // no part of the email address
    expect(ids(STRONG)).toEqual([]);
    expect(passwordIsStrong(STRONG, "ada@example.org")).toBe(true);
    expect(passwordIsStrong("Aa1!" + "x".repeat(300), "ada@example.org")).toBe(false); // too long
  });
});

describe("signing in with a temporary password", () => {
  const loginRequest = (password: string) => new NextRequest("http://localhost:3001/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@acme.example", password }) });

  it("tells the portal the password must be changed, and still sets the session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => (String(url).endsWith("/login") ? json(200, { access_token: "tok", expires_in: 3600, must_change_password: true }) : json(200, { ...orgAdmin, must_change_password: true }))));
    const res = await signIn(loginRequest("Temp!Passw0rd"));
    expect(res.status).toBe(200);
    expect((await res.json()).mustChangePassword).toBe(true);
    expect(res.headers.get("set-cookie")).toContain(`${TENANT_SESSION_COOKIE}=tok`);
  });

  it("an ordinary sign-in is not asked to change anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => (String(url).endsWith("/login") ? json(200, { access_token: "tok", expires_in: 3600, must_change_password: false }) : json(200, orgAdmin))));
    expect((await (await signIn(loginRequest("x"))).json()).mustChangePassword).toBe(false);
  });

  it("an expired temporary password says so, in words, instead of 'disabled'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { detail: { code: "temporary_password_expired", message: "x" } })));
    const res = await signIn(loginRequest("Temp!Passw0rd"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Your temporary password has expired. Ask your administrator to send you a new one.");
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { detail: "Account is disabled" })));
    expect((await (await signIn(loginRequest("x"))).json()).error).toBe("This account is disabled.");
  });

  it("the sign-in form opens the new-password page after a reset, and the dashboard otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { user: { full_name: "Olivia" }, mustChangePassword: true })));
    render(<LoginForm />);
    const u = user();
    await u.type(screen.getByLabelText("Email"), "owner@acme.example");
    await u.type(screen.getByLabelText("Password"), "Temp!Passw0rd");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/change-password"));
    cleanup();
    router.replace.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { user: { full_name: "Olivia" }, mustChangePassword: false })));
    render(<LoginForm />);
    await u.type(screen.getByLabelText("Email"), "owner@acme.example");
    await u.type(screen.getByLabelText("Password"), "Str0ng!Passphrase");
    await u.click(screen.getByRole("button", { name: /Sign in/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });
});

describe("nothing else opens until the new password is chosen", () => {
  it("every page's workspace check sends an administrator on a temporary password to choose their own, before anything is asked of any service", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    jar[TENANT_SESSION_COOKIE] = "tok";
    await expect(loadWorkspace({ ...(orgAdmin as any), must_change_password: true })).rejects.toThrow("REDIRECT:/change-password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an administrator who is not on a temporary password is not redirected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, {})));
    jar[TENANT_SESSION_COOKIE] = "tok";
    await expect(loadWorkspace({ ...(orgAdmin as any), must_change_password: false })).rejects.toThrow("REDIRECT:/login"); // it went on to ask the services (which refused here)
  });
});

describe("the new-password form", () => {
  const draw = (forced = true) => render(<ChangePasswordForm email="ada@example.org" forced={forced} />);
  const fill = async (current: string, next: string, again: string) => {
    const u = user();
    await u.type(screen.getByLabelText(/password \(from the email\)|Current password/i), current);
    await u.type(screen.getByLabelText("New password"), next);
    await u.type(screen.getByLabelText("Type the new password again"), again);
    return u;
  };

  it("asks for the temporary password, the new one twice, and shows the rules ticking off", async () => {
    draw();
    expect(screen.getByLabelText("Temporary password (from the email)")).toBeTruthy();
    const rules = () => Array.from(document.querySelectorAll("[data-rule]")).map((li) => [li.getAttribute("data-rule"), li.getAttribute("data-ok")]);
    expect(rules().filter(([, ok]) => ok === "false").map(([id]) => id)).toEqual(["length", "lower", "upper", "digit", "symbol"]); // "no part of your email" is true of an empty box
    await user().type(screen.getByLabelText("New password"), STRONG);
    expect(rules().every(([, ok]) => ok === "true")).toBe(true);
    expect(rules().map(([id]) => id)).toEqual(["length", "lower", "upper", "digit", "symbol", "email"]);
  });

  it("the button stays off until the new password follows every rule, matches its confirmation and differs from the temporary one", async () => {
    draw();
    const save = screen.getByRole("button", { name: "Save new password" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const u = await fill("Temp!Passw0rd", "weak", "weak");
    expect(save.disabled).toBe(true);
    await u.clear(screen.getByLabelText("New password"));
    await u.clear(screen.getByLabelText("Type the new password again"));
    await u.type(screen.getByLabelText("New password"), STRONG);
    await u.type(screen.getByLabelText("Type the new password again"), STRONG + "x");
    expect(save.disabled).toBe(true);
    expect(screen.getByText("The two passwords are not the same.")).toBeTruthy();
    await u.clear(screen.getByLabelText("Type the new password again"));
    await u.type(screen.getByLabelText("Type the new password again"), STRONG);
    expect(save.disabled).toBe(false);
  });

  it("refuses to reuse the temporary password as the new one", async () => {
    draw();
    await fill(STRONG, STRONG, STRONG);
    expect(screen.getByText("The new password must be different from the current one.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save new password" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends only the two passwords, then opens the portal", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return json(200, { ok: true }); }));
    draw();
    const u = await fill("Temp!Passw0rd", STRONG, STRONG);
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(calls).toEqual([{ url: "/api/auth/change-password", body: { currentPassword: "Temp!Passw0rd", newPassword: STRONG } }]);
  });

  it("shows the refusal in words and stays on the page; an ended session goes to the login page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { error: "The current password is not right." })));
    draw();
    const u = await fill("Wrong!Passw0rd", STRONG, STRONG);
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    expect((await screen.findByRole("alert", {})).textContent).toContain("current password is not right");
    expect(router.replace).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "x" })));
    await u.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("can show the passwords, and says 'current' (not 'temporary') when it was opened on purpose", async () => {
    draw(false);
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.getByLabelText("New password").getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByLabelText("Show the passwords"));
    expect(screen.getByLabelText("New password").getAttribute("type")).toBe("text");
  });
});

describe("POST /api/auth/change-password", () => {
  const request = (body: unknown, cookie: string | null = `${TENANT_SESSION_COOKIE}=old-token`) =>
    new NextRequest("http://localhost:3001/api/auth/change-password", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  let seen: { url: string; init: any }[];
  const stub = (answer: () => Response) => { seen = []; vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => { seen.push({ url: String(url), init }); return answer(); })); };

  it("needs a session and both passwords, and asks nobody otherwise", async () => {
    stub(() => json(200, {}));
    expect((await changePassword(request({ currentPassword: "a", newPassword: "b" }, null))).status).toBe(401);
    expect((await changePassword(request({ currentPassword: "a" }))).status).toBe(400);
    expect((await changePassword(request({ currentPassword: "", newPassword: "b" }))).status).toBe(400);
    expect((await changePassword(request({ currentPassword: "a", newPassword: "x".repeat(300) }))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("asks the Auth Service with the person's own session and nothing else, then replaces the cookie with the fresh sign-in", async () => {
    stub(() => json(200, { access_token: "fresh-token", expires_in: 1800, must_change_password: false }));
    const res = await changePassword(request({ currentPassword: "Temp!Passw0rd", newPassword: STRONG, email: "evil@x.y", role: "super-admin" }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://auth-service:8000/api/v1/auth/me/password");
    expect(seen[0].init.headers.Authorization).toBe("Bearer old-token");
    expect(JSON.parse(seen[0].init.body)).toEqual({ current_password: "Temp!Passw0rd", new_password: STRONG });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${TENANT_SESSION_COOKIE}=fresh-token`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("Max-Age=1800");
    expect(await res.json()).toEqual({ ok: true }); // no token in the body
  });

  it("translates the Auth Service's answers: wrong current password, a weak new one, an ended session, an outage", async () => {
    stub(() => json(403, { detail: { code: "wrong_password", message: "x" } }));
    const wrong = await changePassword(request({ currentPassword: "a", newPassword: STRONG }));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toBe("The current password is not right.");
    stub(() => json(422, { detail: { code: "weak_password", message: "Password must contain: a digit.", problems: ["a digit"] } }));
    const weak = await changePassword(request({ currentPassword: "a", newPassword: "Weak!Password" }));
    expect(weak.status).toBe(422);
    expect(await weak.json()).toMatchObject({ error: "Password must contain: a digit.", problems: ["a digit"] });
    stub(() => json(401, { detail: "Invalid or expired token" }));
    expect((await changePassword(request({ currentPassword: "a", newPassword: STRONG }))).status).toBe(401);
    stub(() => { throw new Error("down"); });
    expect((await changePassword(request({ currentPassword: "a", newPassword: STRONG }))).status).toBe(503);
  });
});
