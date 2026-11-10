import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, formatDate, formatDateTime, formatDecimal, normalizePreferences, type Preferences } from "@/lib/format";
import { changeRequestDraft, changeRequestHref, isChangeKey } from "@/lib/settings-requests";
import { checkCompany, checkDescription, checkEmail, checkPhone, checkWebsite, companyChanges, type CompanyValues } from "@/lib/settings-validation";
import { CURRENCY_OPTIONS, TIMEZONES, currencyOptions, timezoneOptions } from "@/lib/timezones";

const prefs = (over: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...over });

describe("dates and times follow the organization's preferences and never the stored value", () => {
  const instant = "2026-11-07T22:05:30+00:00"; // 7 November 2026, 22:05 UTC

  it("writes the three date formats", () => {
    expect(formatDate(instant, prefs({ date_format: "YYYY-MM-DD" }))).toBe("2026-11-07");
    expect(formatDate(instant, prefs({ date_format: "DD/MM/YYYY" }))).toBe("07/11/2026");
    expect(formatDate(instant, prefs({ date_format: "MM/DD/YYYY" }))).toBe("11/07/2026");
  });

  it("shows the instant in the chosen time zone, which can move the calendar day", () => {
    expect(formatDateTime(instant, prefs({ timezone: "UTC" }))).toBe("2026-11-07 22:05");
    expect(formatDateTime(instant, prefs({ timezone: "Asia/Karachi" }))).toBe("2026-11-08 03:05"); // UTC+5: already the next day
    expect(formatDateTime(instant, prefs({ timezone: "America/New_York", date_format: "MM/DD/YYYY" }))).toBe("11/07/2026 17:05"); // UTC-5 in November
    expect(formatDateTime(instant, prefs({ timezone: "Europe/London", date_format: "DD/MM/YYYY" }))).toBe("07/11/2026 22:05");
  });

  it("handles daylight saving time per the zone's own rules", () => {
    expect(formatDateTime("2026-07-01T12:00:00Z", prefs({ timezone: "America/New_York" }))).toBe("2026-07-01 08:00"); // UTC-4 in July
    expect(formatDateTime("2026-07-01T12:00:00Z", prefs({ timezone: "Europe/London" }))).toBe("2026-07-01 13:00");
  });

  it("midnight is 00:00, never 24:00", () => {
    expect(formatDateTime("2026-11-07T00:00:00Z", prefs())).toBe("2026-11-07 00:00");
  });

  it("changing the preference never changes the stored value: the same instant is written, not rewritten", () => {
    const stored = "2026-11-07T22:05:30+00:00";
    const copy = String(stored);
    formatDateTime(stored, prefs({ timezone: "Asia/Karachi" }));
    expect(stored).toBe(copy);
    expect(new Date(stored).toISOString()).toBe("2026-11-07T22:05:30.000Z");
  });

  it("an unreadable value is returned as it was, and an unknown zone falls back to UTC", () => {
    expect(formatDate("not a date", prefs())).toBe("not a date");
    expect(formatDateTime("2026-11-07T10:00:00Z", prefs({ timezone: "Mars/Olympus" }))).toBe("2026-11-07 10:00");
  });
});

describe("numbers are only re-written, never rounded or converted", () => {
  it.each([
    ["comma_dot", "1,234,567.89"], ["dot_comma", "1.234.567,89"], ["space_comma", "1 234 567,89"], ["indian", "12,34,567.89"],
  ] as const)("%s", (format, expected) => {
    expect(formatDecimal("1234567.89", prefs({ number_format: format }))).toBe(expected);
  });

  it("keeps every digit (no rounding) and pads only when asked", () => {
    expect(formatDecimal("1234.56789", prefs())).toBe("1,234.56789");
    expect(formatDecimal("12", prefs(), 2)).toBe("12.00");
    expect(formatDecimal("12.5", prefs({ number_format: "dot_comma" }), 2)).toBe("12,50");
    expect(formatDecimal("0.1", prefs())).toBe("0.1");
    expect(formatDecimal("9007199254740993.5", prefs())).toBe("9,007,199,254,740,993.5"); // beyond float precision: exact because it is a string
  });

  it("small, negative and indian groupings", () => {
    expect(formatDecimal("999", prefs({ number_format: "indian" }))).toBe("999");
    expect(formatDecimal("1000", prefs({ number_format: "indian" }))).toBe("1,000");
    expect(formatDecimal("100000", prefs({ number_format: "indian" }))).toBe("1,00,000");
    expect(formatDecimal("-1234.5", prefs())).toBe("-1,234.5");
    expect(formatDecimal(1234.5, prefs())).toBe("1,234.5");
  });

  it("anything that is not a plain decimal is returned as it was", () => {
    for (const odd of ["", "abc", "1e9", "1,234.5", "--1", " "]) expect(formatDecimal(odd, prefs())).toBe(odd);
  });
});

describe("normalizePreferences", () => {
  it("accepts what the service sends and falls back to the defaults for anything else", () => {
    expect(normalizePreferences({ default_currency: "PKR", timezone: "Asia/Karachi", date_format: "DD/MM/YYYY", number_format: "indian" })).toEqual({ default_currency: "PKR", timezone: "Asia/Karachi", date_format: "DD/MM/YYYY", number_format: "indian" });
    expect(normalizePreferences({ default_currency: "usd", timezone: "Nowhere/Land", date_format: "D-M-Y", number_format: "weird" })).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({})).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("company validation (the same rules as the Organization Service)", () => {
  const good = { name: "Alpha Trading", contact_email: "ops@alpha.example", contact_phone: "", address_street: "", address_city: "", address_state: "", address_postal_code: "", website: "", description: "" };

  it("normalizes: spaces collapsed, e-mail lower-cased, https added to the website", () => {
    const r = checkCompany({ ...good, name: "  Alpha   Trading  GmbH ", contact_email: " Office@Alpha.EXAMPLE ", contact_phone: " +92  21 1234567 ", website: "WWW.Alpha.example/about", address_city: "  Karachi ", description: " a \n\n\n\n b " });
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ name: "Alpha Trading GmbH", contact_email: "office@alpha.example", contact_phone: "+92 21 1234567", website: "https://www.alpha.example/about", address_city: "Karachi", description: "a\n\nb" }) });
  });

  it.each([
    ["name", "A"], ["name", "<script>x</script>"], ["contact_email", "nope"], ["contact_email", ""], ["contact_email", "a@b"], ["contact_email", "a b@c.example"], ["contact_phone", "abc"], ["contact_phone", "12"],
    ["website", "javascript:alert(1)"], ["website", "ftp://x.example"], ["website", "https://u:p@x.example"], ["website", "https://nodot"], ["address_city", "<b>x</b>"], ["address_street", "x".repeat(256)],
    ["address_postal_code", "x".repeat(31)], ["description", "x".repeat(1001)], ["description", "<img src=x onerror=alert(1)>"],
  ])("refuses %s = %j", (field, value) => {
    const r = checkCompany({ ...good, [field]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual([field]);
  });

  it("optional fields may be empty; the required two may not", () => {
    expect(checkCompany(good).ok).toBe(true);
    expect(checkCompany({ ...good, name: "" }).ok).toBe(false);
    expect(checkCompany({ ...good, contact_email: "" }).ok).toBe(false);
  });

  it("single checks", () => {
    expect(checkEmail(" A@B.CO ")).toEqual({ ok: true, value: "a@b.co" });
    expect(checkPhone("(021) 123-4567")).toEqual({ ok: true, value: "(021) 123-4567" });
    expect(checkWebsite("http://localhost.example:8080/x?y=1")).toEqual({ ok: true, value: "http://localhost.example:8080/x?y=1" });
    expect(checkWebsite("https://alpha.example/")).toEqual({ ok: true, value: "https://alpha.example" });
    expect(checkWebsite("https://alpha.example:8443/shop")).toEqual({ ok: true, value: "https://alpha.example:8443/shop" });
    for (const bad of ["https://alpha.example:99999", "https://alpha.example:abc", "alpha.example:70000", "https://alpha.example:-1"]) expect(checkWebsite(bad).ok, bad).toBe(false);
    expect(checkDescription("line one\r\nline two")).toEqual({ ok: true, value: "line one\nline two" });
  });

  it("companyChanges sends only what differs, and clears an optional field with null", () => {
    const saved: CompanyValues = { ...good, contact_phone: "+1 555 0100", website: "https://a.example" };
    expect(companyChanges(saved, { ...saved })).toEqual({});
    expect(companyChanges(saved, { ...saved, name: "New Name" })).toEqual({ name: "New Name" });
    expect(companyChanges(saved, { ...saved, contact_phone: "", website: "" })).toEqual({ contact_phone: null, website: null });
  });
});

describe("fixed-wording requests", () => {
  it("only known keys, with fixed text", () => {
    expect(isChangeKey("tax_id")).toBe(true);
    for (const bad of ["<script>", "", "sales", undefined, null, 5]) expect(isChangeKey(bad)).toBe(false);
    expect(changeRequestDraft("tax_id").subject).toBe("Request to change our tax registration number");
    expect(changeRequestDraft("country").message).toContain("registered country or jurisdiction");
    expect(changeRequestHref("slug")).toBe("/support/new?change=slug");
  });
});

describe("the lists offered in Settings", () => {
  it("name the zones and currencies the brief asks for, and never lose the saved one", () => {
    for (const z of ["Asia/Karachi", "America/New_York", "Europe/London", "UTC"]) expect(TIMEZONES).toContain(z);
    for (const c of ["PKR", "USD", "EUR", "GBP", "AED"]) expect(CURRENCY_OPTIONS).toContain(c);
    expect(timezoneOptions("Asia/Tokyo")).toEqual(TIMEZONES); // already listed: nothing is added
    expect(timezoneOptions("Pacific/Fiji")[0]).toBe("Pacific/Fiji"); // valid but not listed: kept, not lost
    expect(currencyOptions("XOF")).toEqual(CURRENCY_OPTIONS); // listed: nothing is added
    expect(currencyOptions("ZZZ")[0]).toBe("ZZZ"); // not listed: kept, not lost
    expect(new Set(TIMEZONES).size).toBe(TIMEZONES.length);
    for (const z of TIMEZONES) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: z })).not.toThrow();
  });
});
