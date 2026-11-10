// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => null, useRouter: () => router }));

import SetupWizard from "@/app/setup/setup-wizard";
import PortalShell from "@/components/dashboard/frame";
import { CURRENCIES } from "@/lib/currencies";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; method: string; body: any; headers: any };
let calls: Call[];
let server: Record<string, (body: any) => Response | Promise<Response>>;

const STATUS = (extra: Record<string, unknown> = {}) => ({ setup_status: "in_progress", setup_completed_at: null, company_name: "Alpha Trading", has_logo: true, logo_version: "17", can_edit: true, ...extra });

function stub() {
  calls = [];
  server = {};
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers ?? {} });
    const handler = server[`${method} ${url}`];
    if (handler) return handler(body);
    return json(404, { error: "not found" });
  }));
}
const made = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);

beforeEach(() => { router.replace.mockReset(); router.refresh.mockReset(); router.push.mockReset(); stub(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const png = (size = 5000, type = "image/png", name = "logo.png") => new File([new Uint8Array(size)], name, { type });
const user = () => userEvent.setup({ applyAccept: false });

const props = (extra: Record<string, unknown> = {}) => ({
  mode: "full" as const, setupStatus: "pending", initialCompanyName: "Alpha Trading GmbH", hasLogo: false, logoVersion: null as string | null,
  initialCurrency: "USD", initialFullName: "Olivia Owner", email: "owner@acme.example", ...extra,
});
const mount = (extra: Record<string, unknown> = {}) => render(<SetupWizard {...props(extra)} />);
const fileInput = () => screen.getByLabelText("Choose a logo file") as HTMLInputElement;
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

const withLogo = () => { server["POST /api/setup/logo"] = () => json(200, { setup: STATUS() }); };
async function chooseLogo(u = user(), file = png()) {
  await u.upload(fileInput(), file);
  await screen.findByAltText("Your company logo");
}

// =====================================================================================================
// step 1: company identity
// =====================================================================================================
describe("Step 1: company identity", () => {
  it("welcomes, explains, and shows the progress", () => {
    mount();
    expect(heading()).toBe("Welcome to Impex");
    expect(screen.getByText("Let's personalize your company workspace before you get started.")).toBeTruthy();
    const steps = within(screen.getByRole("list", { name: "Setup progress" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["1Company", "2You", "3Review"]);
    expect(steps[0].getAttribute("aria-current")).toBe("step");
    expect((screen.getByLabelText("Company name") as HTMLInputElement).value).toBe("Alpha Trading GmbH"); // prefilled from the Organization Service
    expect(calls).toHaveLength(0);
  });

  it("uploads the chosen file and shows the stored logo as the preview", async () => {
    withLogo();
    mount();
    await chooseLogo();
    const [post] = made("POST", "/api/setup/logo");
    expect((post.body as FormData).get("file")).toBeInstanceOf(File);
    expect([...(post.body as FormData).keys()]).toEqual(["file"]);
    expect(post.headers["Content-Type"]).toBeUndefined(); // the browser sets the multipart boundary
    expect((screen.getByAltText("Your company logo") as HTMLImageElement).getAttribute("src")).toBe("/api/organization/logo?v=17"); // from the server, not a local blob
    expect(screen.getByRole("button", { name: "Replace logo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("accepts a file dropped on the area", async () => {
    withLogo();
    mount();
    const zone = screen.getByRole("button", { name: "Company logo" });
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    fireEvent.drop(zone, { dataTransfer: { files: [png()] } });
    await screen.findByAltText("Your company logo");
    expect(made("POST", "/api/setup/logo")).toHaveLength(1);
  });

  it("the drop area works from the keyboard", async () => {
    mount();
    const click = vi.spyOn(fileInput(), "click");
    const zone = screen.getByRole("button", { name: "Company logo" });
    zone.focus();
    await user().keyboard("{Enter}");
    await user().keyboard(" ");
    expect(click).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an SVG", new File(["<svg/>"], "l.svg", { type: "image/svg+xml" }), /PNG, JPEG or WebP/],
    ["a GIF", new File(["GIF89a"], "l.gif", { type: "image/gif" }), /PNG, JPEG or WebP/],
    ["a PDF", new File(["%PDF"], "l.pdf", { type: "application/pdf" }), /PNG, JPEG or WebP/],
    ["a file over 2 MB", png(2 * 1024 * 1024 + 1), /2 MB/],
  ])("refuses %s before uploading", async (_name, file, message) => {
    mount();
    await user().upload(fileInput(), file);
    expect(screen.getByRole("alert").textContent).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("shows the service's reason when it refuses the picture", async () => {
    server["POST /api/setup/logo"] = () => json(400, { error: "The logo must be at least 64 x 64 pixels.", code: "too_small" });
    mount();
    await user().upload(fileInput(), png());
    expect((await screen.findByRole("alert")).textContent).toBe("The logo must be at least 64 x 64 pixels.");
    expect(screen.queryByAltText("Your company logo")).toBeNull();
  });

  it("a lost connection is explained and the same file can be tried again", async () => {
    server["POST /api/setup/logo"] = () => { throw new TypeError("network"); };
    mount();
    const u = user();
    await u.upload(fileInput(), png());
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the server");
    server["POST /api/setup/logo"] = () => json(200, { setup: STATUS() });
    await u.upload(fileInput(), png());
    await screen.findByAltText("Your company logo");
  });

  it("replaces and removes the logo", async () => {
    withLogo();
    mount();
    const u = user();
    await chooseLogo(u);
    server["POST /api/setup/logo"] = () => json(200, { setup: STATUS({ logo_version: "18" }) });
    await u.upload(fileInput(), png(6000));
    await waitFor(() => expect((screen.getByAltText("Your company logo") as HTMLImageElement).getAttribute("src")).toBe("/api/organization/logo?v=18"));
    server["DELETE /api/setup/logo"] = () => json(200, { setup: STATUS({ has_logo: false, logo_version: null }) });
    await u.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByRole("button", { name: "Company logo" }); // the drop area is back
    expect(made("DELETE", "/api/setup/logo")).toHaveLength(1);
  });

  it("needs a logo and a valid company name before continuing; nothing is sent until then", async () => {
    mount();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Upload your company logo to continue.")).toBeTruthy();
    expect(calls).toHaveLength(0);
    withLogo();
    await chooseLogo(u);
    for (const bad of ["", "A", "<script>"]) {
      await u.clear(screen.getByLabelText("Company name"));
      if (bad) await u.type(screen.getByLabelText("Company name"), bad);
      await u.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByRole("alert").textContent, bad).toMatch(/company name|Use letters/i);
    }
    expect(made("PUT", "/api/setup/company")).toHaveLength(0);
    expect(heading()).toBe("Welcome to Impex");
  });

  it("saves the cleaned company name and moves to step 2", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.clear(screen.getByLabelText("Company name"));
    await u.type(screen.getByLabelText("Company name"), "  Alpha   Trading AG ");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(heading()).toBe("Tell us about yourself"));
    expect(made("PUT", "/api/setup/company")[0].body).toEqual({ companyName: "Alpha Trading AG", defaultCurrency: "USD" }); // only the name and the currency: no slug, no ids
    expect(screen.getByRole("list", { name: "Setup progress" }).querySelector('[aria-current="step"]')!.textContent).toBe("2You");
  });

  it("stays on step 1 and explains when the service refuses the name", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(400, { error: "Company setup is already completed.", code: "setup_completed" });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Company setup is already completed.");
    expect(heading()).toBe("Welcome to Impex");
  });
});

// =====================================================================================================
// step 1: the default currency
// =====================================================================================================
describe("Step 1: the default currency", () => {
  const select = () => screen.getByLabelText("Default currency") as HTMLSelectElement;

  it("is a dropdown with every currency, each shown as its code and name, starting from the organization's current default", () => {
    mount({ initialCurrency: "PKR" });
    expect(select().tagName).toBe("SELECT");
    expect(select().value).toBe("PKR");
    const options = within(select()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toHaveLength(CURRENCIES.length);
    expect(options.length).toBeGreaterThan(140);
    for (const text of ["USD — US Dollar", "EUR — Euro", "GBP — British Pound Sterling", "JPY — Japanese Yen", "PKR — Pakistani Rupee", "AED — UAE Dirham", "INR — Indian Rupee", "CHF — Swiss Franc", "ZWL — Zimbabwean Dollar"]) expect(options, text).toContain(text);
    expect(new Set(options).size).toBe(options.length);
  });

  it("explains it, with the United States example", () => {
    mount();
    expect(screen.getByText(/for example USD if you are based in the United States/)).toBeTruthy();
    expect(select().getAttribute("aria-describedby")).toBe("currency-help");
  });

  it("an American company picks USD; the choice is saved with the company step and shown on the review", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    mount({ initialCurrency: "EUR" });
    const u = user();
    await chooseLogo(u);
    await u.selectOptions(select(), "USD");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(heading()).toBe("Tell us about yourself"));
    expect(made("PUT", "/api/setup/company")[0].body).toEqual({ companyName: "Alpha Trading GmbH", defaultCurrency: "USD" });
    server["PUT /api/setup/profile"] = () => json(200, { user: { full_name: "Olivia Owner" } });
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review and complete");
    const row = screen.getByText("Default currency").closest("div")!;
    expect(row.textContent).toContain("USD — US Dollar");
  });

  it("another currency (here Japanese Yen) is sent as chosen, and completion confirms it", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    server["PUT /api/setup/profile"] = () => json(200, { user: { full_name: "Olivia Owner" } });
    server["POST /api/setup/complete"] = () => json(200, { done: true, redirectTo: "/" });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.selectOptions(select(), "JPY");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Tell us about yourself");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review and complete");
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(made("PUT", "/api/setup/company")[0].body.defaultCurrency).toBe("JPY");
    expect(made("POST", "/api/setup/complete")[0].body).toEqual({ fullName: "Olivia Owner", companyName: "Alpha Trading GmbH", defaultCurrency: "JPY" });
  });

  it("the review's Edit for the currency goes back to step 1, and a change there is what completes", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    server["PUT /api/setup/profile"] = () => json(200, { user: { full_name: "Olivia Owner" } });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Tell us about yourself");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review and complete");
    await u.click(within(screen.getByText("Default currency").closest("div")!.parentElement!).getByRole("button", { name: "Edit" }));
    expect(heading()).toBe("Welcome to Impex");
    await u.selectOptions(select(), "GBP");
    expect(select().value).toBe("GBP");
  });

  it("a currency that is not in the list is never sent: the browser stops it first", async () => {
    withLogo();
    mount({ initialCurrency: "" });
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByText("Choose your currency from the list.")).getAttribute("role")).toBe("alert");
    expect(made("PUT", "/api/setup/company")).toHaveLength(0);
    expect(heading()).toBe("Welcome to Impex");
  });

  it("shows the service's refusal of the currency next to the field", async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(400, { error: "Choose a valid currency from the list.", code: "invalid_currency", fieldErrors: { defaultCurrency: "Choose a valid currency from the list." } });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getAllByText("Choose a valid currency from the list.").length).toBeGreaterThan(0));
    expect(heading()).toBe("Welcome to Impex");
  });

  it("is not asked of a new administrator joining a company that is already set up", () => {
    mount({ mode: "profile", setupStatus: "completed" });
    expect(screen.queryByLabelText("Default currency")).toBeNull();
  });
});

// =====================================================================================================
// step 2: the administrator
// =====================================================================================================
describe("Step 2: the administrator", () => {
  const atStepTwo = async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Tell us about yourself");
    return u;
  };

  it("is prefilled with the account's name and saves a corrected one", async () => {
    server["PUT /api/setup/profile"] = () => json(200, { user: { full_name: "Olivia Owner-Smith" } });
    const u = await atStepTwo();
    expect(screen.getByText("Set the name that will represent you across your workspace.")).toBeTruthy();
    expect((screen.getByLabelText("Administrator full name") as HTMLInputElement).value).toBe("Olivia Owner");
    await u.clear(screen.getByLabelText("Administrator full name"));
    await u.type(screen.getByLabelText("Administrator full name"), " Olivia   Owner-Smith ");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(heading()).toBe("Review and complete"));
    expect(made("PUT", "/api/setup/profile")[0].body).toEqual({ fullName: "Olivia Owner-Smith" }); // nothing but the name
  });

  it("refuses a bad name without a request", async () => {
    const u = await atStepTwo();
    for (const bad of ["", "A", "<b>", "Jane 3rd"]) {
      await u.clear(screen.getByLabelText("Administrator full name"));
      if (bad) await u.type(screen.getByLabelText("Administrator full name"), bad);
      await u.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByRole("alert")).toBeTruthy();
    }
    expect(made("PUT", "/api/setup/profile")).toHaveLength(0);
    expect(heading()).toBe("Tell us about yourself");
  });

  it("goes back to the company step with everything still entered", async () => {
    const u = await atStepTwo();
    await u.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Welcome to Impex");
    expect((screen.getByLabelText("Company name") as HTMLInputElement).value).toBe("Alpha Trading GmbH");
    expect(screen.getByAltText("Your company logo")).toBeTruthy();
  });

  it("shows the service's refusal and stays", async () => {
    server["PUT /api/setup/profile"] = () => json(403, { error: "Profile setup is only for organization administrators." });
    const u = await atStepTwo();
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("only for organization administrators");
    expect(heading()).toBe("Tell us about yourself");
  });
});

// =====================================================================================================
// step 3: review and complete
// =====================================================================================================
describe("Step 3: review and complete", () => {
  const atReview = async () => {
    withLogo();
    server["PUT /api/setup/company"] = () => json(200, { setup: STATUS() });
    server["PUT /api/setup/profile"] = () => json(200, { user: { full_name: "Olivia Owner" } });
    mount();
    const u = user();
    await chooseLogo(u);
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Tell us about yourself");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review and complete");
    return u;
  };

  it("summarises the logo, the company, the name and the read-only email, and previews the branding", async () => {
    await atReview();
    const summary = document.body;
    expect(summary.textContent).toContain("Alpha Trading GmbH");
    expect(summary.textContent).toContain("Olivia Owner");
    expect(summary.textContent).toContain("owner@acme.example");
    expect(screen.getAllByAltText("Company logo").length).toBeGreaterThan(0);
    const preview = screen.getByRole("img", { name: "Dashboard branding preview" });
    expect(preview.textContent).toContain("Admin Portal");
    expect(preview.textContent).toContain("Alpha Trading GmbH");
    expect(preview.querySelector("img")!.getAttribute("src")).toBe("/api/organization/logo?v=17");
    expect(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" })).toBeTruthy();
  });

  it("lets you return to either earlier step to correct something", async () => {
    const u = await atReview();
    const edits = screen.getAllByRole("button", { name: "Edit" });
    expect(edits).toHaveLength(3); // company, currency, administrator
    await u.click(edits[2]);
    expect(heading()).toBe("Tell us about yourself");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review and complete");
    await u.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(heading()).toBe("Welcome to Impex");
  });

  it("completes: sends the confirmed names, then goes to the dashboard automatically", async () => {
    server["POST /api/setup/complete"] = () => json(200, { done: true, redirectTo: "/" });
    const u = await atReview();
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(router.refresh).toHaveBeenCalled();
    expect(made("POST", "/api/setup/complete")[0].body).toEqual({ fullName: "Olivia Owner", companyName: "Alpha Trading GmbH", defaultCurrency: "USD" });
  });

  it("a double click submits once, and the button stays disabled while the browser moves on", async () => {
    let release: (r: Response) => void = () => undefined;
    server["POST /api/setup/complete"] = () => new Promise<Response>((resolve) => { release = resolve; });
    const u = await atReview();
    const button = screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" });
    await u.dblClick(button);
    expect((screen.getByRole("button", { name: "Finishing setup…" }) as HTMLButtonElement).disabled).toBe(true);
    release(json(200, { done: true, redirectTo: "/" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(made("POST", "/api/setup/complete")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Finishing setup…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failure is explained, nothing is lost, and the button works again", async () => {
    server["POST /api/setup/complete"] = () => json(503, { error: "Your company was set up, but your profile could not be saved yet. Please try again.", code: "unavailable", companySetupDone: true });
    const u = await atReview();
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your company was set up");
    expect(router.replace).not.toHaveBeenCalled();
    server["POST /api/setup/complete"] = () => json(200, { done: true, redirectTo: "/" });
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(made("POST", "/api/setup/complete")).toHaveLength(2);
  });

  it("a missing logo reported by the service is shown", async () => {
    server["POST /api/setup/complete"] = () => json(409, { error: "Upload your company logo to finish setup.", code: "logo_required" });
    const u = await atReview();
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Upload your company logo");
  });

  it("an expired session goes to the login page", async () => {
    server["POST /api/setup/complete"] = () => json(401, { error: "Your session has expired. Please sign in again." });
    const u = await atReview();
    await u.click(screen.getByRole("button", { name: "Complete Setup & Enter Dashboard" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

// =====================================================================================================
// resuming, and the short profile screen
// =====================================================================================================
describe("resuming after a refresh or an interruption", () => {
  it("a company with a saved name and logo opens at step 2 with the logo already there", async () => {
    mount({ setupStatus: "in_progress", hasLogo: true, logoVersion: "17" });
    expect(heading()).toBe("Tell us about yourself");
    await user().click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByAltText("Your company logo").getAttribute("src")).toBe("/api/organization/logo?v=17");
  });
  it("nothing saved yet: step 1", () => {
    mount({ setupStatus: "pending" });
    expect(heading()).toBe("Welcome to Impex");
  });
});

describe("a new administrator of an already configured company", () => {
  const profileOnly = (extra: Record<string, unknown> = {}) => mount({ mode: "profile", setupStatus: "completed", hasLogo: true, logoVersion: "5", ...extra });

  it("sees a short welcome, the company they are joining, and only their own name", () => {
    profileOnly();
    expect(heading()).toBe("Welcome, let's confirm your name");
    expect(screen.getByText("You are joining")).toBeTruthy();
    expect(screen.getByText("Alpha Trading GmbH")).toBeTruthy();
    expect(screen.getByAltText("Company logo").getAttribute("src")).toBe("/api/organization/logo?v=5");
    expect(screen.queryByLabelText("Company name")).toBeNull();
    expect(screen.queryByLabelText("Choose a logo file")).toBeNull();
    expect(screen.queryByRole("list", { name: "Setup progress" })).toBeNull();
    const email = screen.getByLabelText("Account email") as HTMLInputElement;
    expect(email.readOnly).toBe(true);
  });

  it("confirms the name without touching the company, then enters the dashboard", async () => {
    server["POST /api/setup/complete"] = () => json(200, { done: true, redirectTo: "/" });
    profileOnly();
    const u = user();
    await u.clear(screen.getByLabelText("Administrator full name"));
    await u.type(screen.getByLabelText("Administrator full name"), "Bob Two");
    await u.click(screen.getByRole("button", { name: "Continue to Dashboard" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(made("POST", "/api/setup/complete")[0].body).toEqual({ fullName: "Bob Two" }); // no company fields at all
    expect(calls.map((c) => c.url)).toEqual(["/api/setup/complete"]);
  });

  it("refuses a bad name and shows a failure", async () => {
    profileOnly();
    const u = user();
    await u.clear(screen.getByLabelText("Administrator full name"));
    await u.click(screen.getByRole("button", { name: "Continue to Dashboard" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(calls).toHaveLength(0);
    await u.type(screen.getByLabelText("Administrator full name"), "Bob Two");
    server["POST /api/setup/complete"] = () => json(503, { error: "We couldn't reach the service just now.", code: "unavailable" });
    await u.click(screen.getByRole("button", { name: "Continue to Dashboard" }));
    expect((await screen.findByRole("alert")).textContent).toContain("couldn't reach the service");
    expect((screen.getByRole("button", { name: "Continue to Dashboard" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a company without a logo (set up before logos existed) shows a monogram instead", () => {
    profileOnly({ hasLogo: false, logoVersion: null });
    expect(screen.queryByAltText("Company logo")).toBeNull();
    expect(screen.getByText("AT")).toBeTruthy();
  });
});

// =====================================================================================================
// branding in the portal header
// =====================================================================================================
describe("the portal shell shows the company identity", () => {
  const admin = { full_name: "Ada Lovelace", email: "ada@acme.example" } as any;
  it("logo, company name and the administrator's name (in the avatar's card)", () => {
    render(<PortalShell admin={admin} current="dashboard" organization={{ name: "Alpha Trading GmbH", has_logo: true, logo_version: "9" }}>{null}</PortalShell>);
    expect((screen.getByAltText("Alpha Trading GmbH logo") as HTMLImageElement).getAttribute("src")).toBe("/api/organization/logo?v=9");
    expect(screen.queryByText("Admin Portal")).toBeNull();
    expect(screen.getByText("Alpha Trading GmbH")).toBeTruthy();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
  it("a monogram when there is no logo, and the platform mark when there is no organization at all", () => {
    const { unmount } = render(<PortalShell admin={admin} current="dashboard" organization={{ name: "Alpha Trading GmbH", has_logo: false }}>{null}</PortalShell>);
    expect(screen.getByText("AT")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    unmount();
    render(<PortalShell admin={admin} current="dashboard">{null}</PortalShell>);
    expect(screen.getAllByText("IX").length).toBeGreaterThan(0); // the platform mark in the sidebar
    expect(screen.queryByText("Alpha Trading GmbH")).toBeNull(); // no organization: no company in the card either
  });
  it("lists every enabled page with its route", () => {
    render(<PortalShell admin={admin} current="invoices" organization={{ name: "Acme", has_logo: false, modules: ["inventory", "purchasing", "sales"] }}>{null}</PortalShell>);
    const links = screen.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);
    expect(links).toContainEqual(["Dashboard", "/"]);
    expect(links).toContainEqual(["Sales Invoice", "/invoices/sales"]);
    expect(links).toContainEqual(["Suppliers Invoice", "/invoices/suppliers"]);
    expect(links).toContainEqual(["Help & Support", "/support"]);
  });
});
