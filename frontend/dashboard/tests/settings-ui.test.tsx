// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import SettingsView from "@/app/settings/settings-view";
import InvoiceForm from "@/app/invoices/invoice-form";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ORG_ID = "6f1c0e0a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

const settings = (over: Record<string, any> = {}) => ({
  version: 3, setup_status: "completed", updated_at: null,
  company: { name: "Alpha Trading GmbH", contact_email: "ops@alpha.example", contact_phone: null, address_street: null, address_city: "Hamburg", address_state: null, address_postal_code: null, website: null, description: null },
  restricted: { id: ORG_ID, slug: "alpha-trading", country_code: "DE", tax_identifier: "DE111111111", owner_email: "owner@alpha.example", status: "Active", created_at: "2026-11-01T10:00:00+00:00" },
  branding: { has_logo: false, logo_version: null },
  preferences: { default_currency: "USD", timezone: "UTC", date_format: "YYYY-MM-DD", number_format: "comma_dot" },
  ...over,
});
const admin = { id: "11111111-1111-4111-8111-111111111111", full_name: "Olivia Owner", email: "owner@acme.example", role: "organization-admin", organization_id: ORG_ID };
const view = (over: { initial?: any; history?: any; modules?: unknown } = {}) =>
  render(<SettingsView initial={over.initial ?? settings()} history={over.history ?? { items: [], total: 0 }} admin={admin} modules={over.modules ?? ["inventory"]} now="2026-11-07T10:00:00.000Z" />);

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
function stub(handler: (call: Call) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.url.includes("/api/settings/history")) return json(200, { items: [], total: 0 });
    return handler(call);
  }));
}
const saves = () => calls.filter((c) => !c.url.includes("/history"));

beforeEach(() => {
  calls = [];
  router.replace.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const png = (name = "logo.png") => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], name, { type: "image/png" });

describe("Company profile", () => {
  it("is prefilled from the saved company, with proper labels", () => {
    view();
    expect((screen.getByLabelText("Company display name") as HTMLInputElement).value).toBe("Alpha Trading GmbH");
    expect((screen.getByLabelText("Business contact email") as HTMLInputElement).value).toBe("ops@alpha.example");
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Hamburg");
    expect((screen.getByLabelText("Phone number") as HTMLInputElement).value).toBe("");
    for (const label of ["Street address", "State / province", "Postal code", "Company website", "Business description"]) expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it("Save is off until something changes, and sends only what changed with the version it was made from", async () => {
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, name: "Alpha Trading International", contact_phone: "+49 30 1234567" } }) }));
    view();
    const save = within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText("Company display name"));
    await userEvent.type(screen.getByLabelText("Company display name"), "Alpha Trading International");
    await userEvent.type(screen.getByLabelText("Phone number"), "+49 30 1234567");
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await screen.findByText("Company profile saved.");
    expect(saves()).toHaveLength(1);
    expect(saves()[0].url).toBe("/api/settings/company");
    expect(saves()[0].method).toBe("PATCH");
    expect(saves()[0].body).toEqual({ expected_version: 3, name: "Alpha Trading International", contact_phone: "+49 30 1234567" });
    expect(router.refresh).toHaveBeenCalled(); // the name changed: the header follows without a full reload
    expect(save.disabled).toBe(true); // saved: nothing unsaved any more
  });

  it("a change that is not the name does not need to refresh the header", async () => {
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, address_city: "Bonn" } }) }));
    view();
    await userEvent.clear(screen.getByLabelText("City"));
    await userEvent.type(screen.getByLabelText("City"), "Bonn");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Company profile saved.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("explains a bad value beside its field and sends nothing", async () => {
    stub(() => json(200, {}));
    view();
    await userEvent.clear(screen.getByLabelText("Business contact email"));
    await userEvent.type(screen.getByLabelText("Business contact email"), "not-an-email");
    await userEvent.type(screen.getByLabelText("Company website"), "javascript:alert(1)");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Enter a valid e-mail address/)).toBeTruthy();
    expect(screen.getByText(/Enter a valid website address/)).toBeTruthy();
    expect((screen.getByLabelText("Business contact email") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
    expect(saves()).toHaveLength(0);
  });

  it("a double click saves once", async () => {
    let release: (r: Response) => void = () => undefined;
    stub(() => new Promise<Response>((resolve) => { release = resolve; }));
    view();
    await userEvent.type(screen.getByLabelText("Company website"), "alpha.example");
    await userEvent.dblClick(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    expect(saves()).toHaveLength(1);
    expect(within(document.getElementById("company")!).getByRole("button", { name: "Saving…" })).toBeTruthy();
    release(json(200, { settings: settings({ version: 4, company: { ...settings().company, website: "https://alpha.example" } }) }));
    await screen.findByText("Company profile saved.");
    expect((screen.getByLabelText("Company website") as HTMLInputElement).value).toBe("https://alpha.example"); // the normalized value the service stored
  });

  it("a conflict with someone else's change shows the current values instead of overwriting them", async () => {
    const current = settings({ version: 5, company: { ...settings().company, name: "Alpha Renamed Elsewhere" } });
    stub(() => json(409, { error: "These settings were changed by someone else while you were editing.", code: "version_conflict", current }));
    view();
    await userEvent.clear(screen.getByLabelText("Company display name"));
    await userEvent.type(screen.getByLabelText("Company display name"), "My Own Name");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/changed by someone else/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Company display name") as HTMLInputElement).value).toBe("Alpha Renamed Elsewhere"));
    // the next save is made from the NEW version
    stub(() => json(200, { settings: settings({ version: 6, company: { ...current.company, address_city: "Kiel" } }) }));
    await userEvent.clear(screen.getByLabelText("City"));
    await userEvent.type(screen.getByLabelText("City"), "Kiel");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Company profile saved.");
    expect(saves()[0].body.expected_version).toBe(5);
  });

  it("keeps the typed values and shows the error when the service is down", async () => {
    stub(() => json(503, { error: "We couldn't reach the service just now. Nothing was changed; please try again in a moment." }));
    view();
    await userEvent.type(screen.getByLabelText("Company website"), "alpha.example");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Nothing was changed/)).toBeTruthy();
    expect((screen.getByLabelText("Company website") as HTMLInputElement).value).toBe("alpha.example");
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, website: "https://alpha.example" } }) })); // retry works
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Company profile saved.");
  });

  it("shows a field error from the service beside that field", async () => {
    stub(() => json(400, { error: "Enter a valid e-mail address.", fieldErrors: { contact_email: "Enter a valid e-mail address." } }));
    view();
    await userEvent.clear(screen.getByLabelText("Business contact email"));
    await userEvent.type(screen.getByLabelText("Business contact email"), "ok@fine.example");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(document.getElementById("company-contact_email-error")?.textContent).toContain("Enter a valid e-mail address."));
  });

  it("Discard puts the saved values back", async () => {
    view();
    await userEvent.clear(screen.getByLabelText("Company display name"));
    await userEvent.type(screen.getByLabelText("Company display name"), "Typo Inc");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Company display name") as HTMLInputElement).value).toBe("Alpha Trading GmbH");
  });

  it("the registered facts are plain text with a Request change link, and no input", () => {
    view();
    const facts = within(screen.getByLabelText("Registered company information"));
    for (const value of [ORG_ID, "alpha-trading", "DE", "DE111111111", "owner@alpha.example", "Active"]) expect(facts.getByText(value)).toBeTruthy();
    expect(facts.queryAllByRole("textbox")).toHaveLength(0);
    expect(facts.getAllByRole("link", { name: "Request change" }).map((l) => l.getAttribute("href"))).toEqual(["/support/new?change=slug", "/support/new?change=country", "/support/new?change=tax_id", "/support/new?change=ownership", "/support/new?change=status"]);
  });
});

describe("Company branding", () => {
  const brand = () => within(document.getElementById("branding")!);

  it("shows the monogram and the header preview when there is no logo", () => {
    view();
    expect(brand().getByText("No logo: the monogram is shown")).toBeTruthy();
    expect(within(screen.getByLabelText("Header preview")).getByText("AT")).toBeTruthy();
    expect(within(screen.getByLabelText("Header preview")).getByText("Alpha Trading GmbH")).toBeTruthy();
    expect(brand().queryByRole("button", { name: "Remove logo" })).toBeNull();
  });

  it("shows the current logo through the portal's own authenticated route, versioned so a new logo is never shown stale", () => {
    view({ initial: settings({ branding: { has_logo: true, logo_version: "1730000000000" } }) });
    expect(brand().getByAltText("Current company logo").getAttribute("src")).toBe("/api/organization/logo?v=1730000000000");
  });

  it("previews a chosen picture before anything is saved, and uploads it with the version", async () => {
    stub(() => json(200, { settings: settings({ version: 4, branding: { has_logo: true, logo_version: "1740000000000" } }) }));
    view();
    await userEvent.upload(screen.getByLabelText("Upload logo"), png());
    expect(brand().getByAltText("Selected logo preview").getAttribute("src")).toBe("blob:preview");
    expect(screen.getByLabelText("Header preview").querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect(saves()).toHaveLength(0);
    expect(screen.getAllByText(/unsaved/i).length).toBeGreaterThan(0);
    await userEvent.click(brand().getByRole("button", { name: "Save logo" }));
    await screen.findByText("Logo saved.");
    const form = saves()[0].body as FormData;
    expect(saves()[0].url).toBe("/api/settings/logo");
    expect(saves()[0].method).toBe("PUT");
    expect(form.get("expected_version")).toBe("3");
    expect((form.get("file") as File).type).toBe("image/png");
    expect(router.refresh).toHaveBeenCalled();
    expect(brand().getByAltText("Current company logo").getAttribute("src")).toBe("/api/organization/logo?v=1740000000000");
  });

  it("refuses a wrong type or size right away and keeps the current logo", async () => {
    view();
    fireEvent.change(screen.getByLabelText("Upload logo"), { target: { files: [new File([new Uint8Array([1, 2, 3])], "x.gif", { type: "image/gif" })] } });
    expect(await screen.findByText("Use a PNG, JPEG or WebP image.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Upload logo"), { target: { files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })] } });
    expect(await screen.findByText("The logo must be 2 MB or smaller.")).toBeTruthy();
    expect(brand().getByRole("button", { name: "Save logo" }).hasAttribute("disabled")).toBe(true);
    expect(saves()).toHaveLength(0);
  });

  it("shows the service's verdict on the picture's content and keeps the page usable", async () => {
    stub(() => json(400, { error: "The logo must be at least 64 × 64 pixels.", code: "logo_too_small" }));
    view();
    await userEvent.upload(screen.getByLabelText("Upload logo"), png());
    await userEvent.click(brand().getByRole("button", { name: "Save logo" }));
    expect(await screen.findByText("The logo must be at least 64 × 64 pixels.")).toBeTruthy();
  });

  it("replaces an existing logo", async () => {
    stub(() => json(200, { settings: settings({ version: 4, branding: { has_logo: true, logo_version: "1750000000000" } }) }));
    view({ initial: settings({ branding: { has_logo: true, logo_version: "1730000000000" } }) });
    await userEvent.upload(screen.getByLabelText("Replace logo"), png("new.png"));
    await userEvent.click(brand().getByRole("button", { name: "Replace logo" }));
    await screen.findByText("Logo replaced.");
  });

  it("asks before removing, and removing falls back to the monogram", async () => {
    stub(() => json(200, { settings: settings({ version: 4 }) }));
    view({ initial: settings({ branding: { has_logo: true, logo_version: "1730000000000" } }) });
    await userEvent.click(brand().getByRole("button", { name: "Remove logo" }));
    const dialog = brand().getByRole("alertdialog", { name: "Remove the company logo" });
    expect(dialog.textContent).toContain("Invoices that were already issued keep the branding they were issued with");
    expect(saves()).toHaveLength(0); // nothing happens until it is confirmed
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(brand().queryByRole("alertdialog")).toBeNull();
    expect(saves()).toHaveLength(0);
    await userEvent.click(brand().getByRole("button", { name: "Remove logo" }));
    await userEvent.click(brand().getByRole("button", { name: "Yes, remove logo" }));
    await screen.findByText(/Logo removed/);
    expect(saves()[0].url).toBe("/api/settings/logo?expected_version=3");
    expect(saves()[0].method).toBe("DELETE");
    expect(brand().getByText("No logo: the monogram is shown")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a conflict while changing the logo shows the current state", async () => {
    stub(() => json(409, { error: "These settings were changed by someone else while you were editing.", code: "version_conflict", current: settings({ version: 9, branding: { has_logo: true, logo_version: "1760000000000" } }) }));
    view();
    await userEvent.upload(screen.getByLabelText("Upload logo"), png());
    await userEvent.click(brand().getByRole("button", { name: "Save logo" }));
    expect(await screen.findByText(/changed by someone else/)).toBeTruthy();
    await waitFor(() => expect(brand().getByAltText("Current company logo").getAttribute("src")).toBe("/api/organization/logo?v=1760000000000"));
  });
});

describe("Administrator profile", () => {
  const section = () => within(document.getElementById("profile")!);

  it("shows the account, with only the name editable", () => {
    view();
    expect((screen.getByLabelText("Your full name") as HTMLInputElement).value).toBe("Olivia Owner");
    const details = within(screen.getByLabelText("Account details"));
    for (const value of ["owner@acme.example", "Organization administrator", "Alpha Trading GmbH", ORG_ID, admin.id]) expect(details.getByText(value)).toBeTruthy();
    expect(section().getAllByRole("textbox")).toHaveLength(1);
  });

  it("saves the person's own name through the profile route, and the header follows", async () => {
    stub(() => json(200, { user: { full_name: "Olivia Owner-Smith" } }));
    view();
    await userEvent.clear(screen.getByLabelText("Your full name"));
    await userEvent.type(screen.getByLabelText("Your full name"), "  Olivia   Owner-Smith ");
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    await screen.findByText("Your name was saved.");
    expect(saves()[0].url).toBe("/api/settings/profile");
    expect(saves()[0].body).toEqual({ fullName: "Olivia Owner-Smith" });
    expect((screen.getByLabelText("Your full name") as HTMLInputElement).value).toBe("Olivia Owner-Smith");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("refuses an invalid name beside the field and sends nothing", async () => {
    stub(() => json(200, {}));
    view();
    await userEvent.clear(screen.getByLabelText("Your full name"));
    await userEvent.type(screen.getByLabelText("Your full name"), "Jane 3rd");
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Use letters, spaces/)).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it("sends the person to sign in again when the session has ended", async () => {
    stub(() => json(401, { error: "Your session has expired. Please sign in again." }));
    view();
    await userEvent.type(screen.getByLabelText("Your full name"), "x");
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("Business preferences", () => {
  const section = () => within(document.getElementById("preferences")!);

  it("offers the currencies, zones and formats of the brief, and shows the saved choice", () => {
    view({ initial: settings({ preferences: { default_currency: "PKR", timezone: "Asia/Karachi", date_format: "DD/MM/YYYY", number_format: "indian" } }) });
    expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe("PKR");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Asia/Karachi");
    expect((screen.getByLabelText("Date format") as HTMLSelectElement).value).toBe("DD/MM/YYYY");
    expect((screen.getByLabelText("Number format") as HTMLSelectElement).value).toBe("indian");
    const currencies = within(screen.getByLabelText("Default currency")).getAllByRole("option").map((o) => o.textContent);
    for (const c of ["PKR", "USD", "EUR", "GBP", "AED"]) expect(currencies).toContain(c);
    expect(within(screen.getByLabelText("Date format")).getAllByRole("option").map((o) => o.textContent)).toEqual(["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]);
    expect(within(screen.getByLabelText("Number format")).getAllByRole("option").map((o) => o.textContent)).toEqual(["1,234,567.89", "1.234.567,89", "1 234 567,89", "12,34,567.89"]);
  });

  it("previews the choice, and says plainly that nothing already recorded is converted", async () => {
    view();
    expect(within(screen.getByLabelText("Preview")).getByText(/2026-11-07 10:00/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "Asia/Karachi");
    await userEvent.selectOptions(screen.getByLabelText("Date format"), "DD/MM/YYYY");
    await userEvent.selectOptions(screen.getByLabelText("Number format"), "dot_comma");
    await userEvent.selectOptions(screen.getByLabelText("Default currency"), "PKR");
    const preview = within(screen.getByLabelText("Preview"));
    expect(preview.getByText("07/11/2026 15:00")).toBeTruthy(); // 10:00 UTC is 15:00 in Karachi
    expect(preview.getByText("1.234.567,89 PKR")).toBeTruthy();
    expect(section().getByText(/never converts or rewrites anything already recorded/)).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it("saves only what changed, with the version, and refreshes the portal", async () => {
    stub(() => json(200, { settings: settings({ version: 4, preferences: { default_currency: "PKR", timezone: "UTC", date_format: "YYYY-MM-DD", number_format: "comma_dot" } }) }));
    view();
    await userEvent.selectOptions(screen.getByLabelText("Default currency"), "PKR");
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    await screen.findByText("Business preferences saved.");
    expect(saves()[0].url).toBe("/api/settings/preferences");
    expect(saves()[0].body).toEqual({ expected_version: 3, default_currency: "PKR" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the service's refusal and a conflict", async () => {
    stub(() => json(400, { error: "Please correct the highlighted fields.", fieldErrors: { timezone: "Choose a valid time zone such as Asia/Karachi, America/New_York or Europe/London." } }));
    view();
    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "Europe/London");
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Choose a valid time zone/)).toBeTruthy();
    stub(() => json(409, { error: "These settings were changed by someone else while you were editing.", code: "version_conflict", current: settings({ version: 7, preferences: { default_currency: "EUR", timezone: "UTC", date_format: "YYYY-MM-DD", number_format: "comma_dot" } }) }));
    await userEvent.click(section().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect((screen.getByLabelText("Default currency") as HTMLSelectElement).value).toBe("EUR"));
  });
});

describe("Enabled modules", () => {
  it("shows enabled and not enabled modules (Finance too), dependencies and Request access", () => {
    view({ modules: ["inventory", "purchasing"] });
    const rows = within(document.getElementById("modules")!);
    expect(document.querySelector('[data-module="inventory"]')?.getAttribute("data-enabled")).toBe("true");
    expect(document.querySelector('[data-module="purchasing"]')?.getAttribute("data-enabled")).toBe("true");
    expect(document.querySelector('[data-module="sales"]')?.getAttribute("data-enabled")).toBe("false");
    expect(document.querySelector('[data-module="finance"]')?.getAttribute("data-enabled")).toBe("false");
    expect(rows.queryByText("Planned: not available yet")).toBeNull();
    expect(rows.getAllByText(/Requires Inventory/).length).toBe(2);
    expect(rows.getAllByRole("link", { name: "Request access" }).map((a) => a.getAttribute("href"))).toEqual(["/support/new?module=sales", "/support/new?module=finance"]);
    expect(rows.queryAllByRole("checkbox")).toHaveLength(0);
    expect(rows.getByText(/Purchasing and Sales both need Inventory/)).toBeTruthy();
  });
});

describe("unsaved changes", () => {
  it("warns before leaving with unsaved changes, and stops warning once they are saved or discarded", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, website: "https://alpha.example" } }) }));
    view();
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    await userEvent.type(screen.getByLabelText("Company website"), "alpha.example");
    expect(await screen.findByText(/You have unsaved changes in 1 section/)).toBeTruthy();
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    const handler = add.mock.calls.find(([type]) => type === "beforeunload")![1] as (e: BeforeUnloadEvent) => void;
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    handler(event);
    expect(event.defaultPrevented).toBe(true); // the browser asks before the page goes away
    await userEvent.type(screen.getByLabelText("Phone number"), "+49 30 1234567");
    expect(screen.getByText(/in 1 section/)).toBeTruthy(); // the same section
    await userEvent.type(screen.getByLabelText("Your full name"), "x");
    expect(await screen.findByText(/in 2 sections/)).toBeTruthy();
    await userEvent.click(within(document.getElementById("profile")!).getByRole("button", { name: "Discard" }));
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Company profile saved.");
    await waitFor(() => expect(screen.queryByText(/You have unsaved changes in/)).toBeNull());
    expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
  });
});

describe("history", () => {
  it("lists who changed what and when, and refreshes after a save", async () => {
    const items = [{ id: "h1", section: "company", field: "contact_phone", old_value: null, new_value: "+49 30 1234567", changed_by_name: "Olivia Owner", changed_by_email: "o@x.y", source: "settings", version: 3, batch_id: "b", created_at: "2026-11-06T09:30:00+00:00" }];
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, address_city: "Bonn" } }) }));
    view({ history: { items, total: 1 } });
    const panel = within(document.getElementById("history-title")!.closest("section")!);
    expect(panel.getByText("Phone number")).toBeTruthy();
    expect(panel.getByText("Phone number").parentElement!.textContent).toContain("empty → +49 30 1234567");
    expect(panel.getByText(/Olivia Owner · 2026-11-06 09:30/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("City"));
    await userEvent.type(screen.getByLabelText("City"), "Bonn");
    await userEvent.click(within(document.getElementById("company")!).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Company profile saved.");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/history")).toBe(true));
  });
});

describe("layout and accessibility", () => {
  it("has labelled sections, a section navigation, and a responsive layout", () => {
    view();
    for (const id of ["company", "branding", "profile", "preferences", "modules"]) {
      const section = document.getElementById(id)!;
      expect(section.getAttribute("aria-labelledby")).toBe(`${id}-title`);
      expect(document.getElementById(`${id}-title`)!.textContent!.length).toBeGreaterThan(3);
    }
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    expect(nav.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["#company", "#branding", "#profile", "#preferences", "#modules"]);
    const company = document.getElementById("company")!;
    expect(company.innerHTML).toContain("sm:grid-cols-2"); // two columns from the small breakpoint, one on a phone
    expect(company.className).toContain("p-5"); // phone padding, larger from sm:
    for (const input of company.querySelectorAll("input, textarea")) expect(document.querySelector(`label[for="${(input as HTMLElement).id}"]`), (input as HTMLElement).id).not.toBeNull();
  });

  it("every control can be reached and used with the keyboard", async () => {
    stub(() => json(200, { settings: settings({ version: 4, company: { ...settings().company, address_city: "Bonn" } }) }));
    view();
    const city = screen.getByLabelText("City");
    city.focus();
    await userEvent.keyboard("{Control>}a{/Control}Bonn");
    await userEvent.tab({ shift: false });
    expect(document.activeElement).not.toBe(city);
    const save = within(document.getElementById("company")!).getByRole("button", { name: "Save changes" });
    save.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByText("Company profile saved.");
  });
});

describe("new documents start in the default currency", () => {
  it("an invoice form uses the organization's default currency for a NEW invoice, and keeps an existing invoice's own", () => {
    const { unmount } = render(<InvoiceForm clients={[{ id: "c1", name: "Acme Ltd", is_active: true } as any]} clientId="c1" billable={[]} invoice={null} defaultCurrency="PKR" />);
    expect((screen.getByLabelText(/Currency/) as HTMLInputElement).value).toBe("PKR");
    unmount();
    render(<InvoiceForm clients={[{ id: "c1", name: "Acme Ltd", is_active: true } as any]} clientId="c1" billable={[]} invoice={null} />);
    expect((screen.getByLabelText(/Currency/) as HTMLInputElement).value).toBe("USD"); // the old default when nothing was chosen
  });
});
