// How an organization wants dates, times and numbers SHOWN (its Settings -> Business preferences). Presentation only:
//   * a stored timestamp is always a timezone-aware UTC instant; the time zone here only decides how it is written on screen;
//   * a stored amount or quantity is an exact decimal string; these functions only add separators for display and never round, convert
//     or reinterpret it, and the currency of a document is never changed by the default currency chosen in Settings.
// Pure functions: the same output on the server and in the browser (no locale sniffing, so no hydration differences).

export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
export type NumberFormat = "comma_dot" | "dot_comma" | "space_comma" | "indian";
export type Preferences = { default_currency: string; timezone: string; date_format: DateFormat; number_format: NumberFormat };

// What the portal used before preferences existed (and what an organization that never chose gets): US dollars, UTC, ISO dates, 1,234.56.
export const DEFAULT_PREFERENCES: Preferences = { default_currency: "USD", timezone: "UTC", date_format: "YYYY-MM-DD", number_format: "comma_dot" };

export const DATE_FORMAT_OPTIONS: { value: DateFormat; label: string }[] = [
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
];

export const NUMBER_FORMAT_OPTIONS: { value: NumberFormat; label: string }[] = [
  { value: "comma_dot", label: "1,234,567.89" },
  { value: "dot_comma", label: "1.234.567,89" },
  { value: "space_comma", label: "1 234 567,89" },
  { value: "indian", label: "12,34,567.89" },
];

const isDateFormat = (v: unknown): v is DateFormat => DATE_FORMAT_OPTIONS.some((o) => o.value === v);
const isNumberFormat = (v: unknown): v is NumberFormat => NUMBER_FORMAT_OPTIONS.some((o) => o.value === v);

/** Whatever the Organization Service sent, as safe preferences: an unknown or missing value falls back to the default, never throws. */
export function normalizePreferences(raw: Partial<Record<keyof Preferences, unknown>> | null | undefined): Preferences {
  const timezone = typeof raw?.timezone === "string" && validZone(raw.timezone) ? raw.timezone : DEFAULT_PREFERENCES.timezone;
  return {
    default_currency: typeof raw?.default_currency === "string" && /^[A-Z]{3}$/.test(raw.default_currency) ? raw.default_currency : DEFAULT_PREFERENCES.default_currency,
    timezone,
    date_format: isDateFormat(raw?.date_format) ? raw.date_format : DEFAULT_PREFERENCES.date_format,
    number_format: isNumberFormat(raw?.number_format) ? raw.number_format : DEFAULT_PREFERENCES.number_format,
  };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: string; month: string; day: string; hour: string; minute: string };

function partsOf(input: string | Date, timezone: string): Parts | null {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const zone = validZone(timezone) ? timezone : "UTC";
  const found: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date)) found[p.type] = p.value;
  return { year: found.year, month: found.month, day: found.day, hour: found.hour === "24" ? "00" : found.hour, minute: found.minute };
}

function writeDate(p: Parts, format: DateFormat): string {
  if (format === "DD/MM/YYYY") return `${p.day}/${p.month}/${p.year}`;
  if (format === "MM/DD/YYYY") return `${p.month}/${p.day}/${p.year}`;
  return `${p.year}-${p.month}-${p.day}`;
}

/** The calendar date of an instant in the organization's time zone, written in its date format. An unreadable value is returned as it was. */
export function formatDate(input: string | Date, prefs: Preferences = DEFAULT_PREFERENCES): string {
  const parts = partsOf(input, prefs.timezone);
  return parts ? writeDate(parts, prefs.date_format) : String(input);
}

/** Date and time (24-hour) of an instant in the organization's time zone. */
export function formatDateTime(input: string | Date, prefs: Preferences = DEFAULT_PREFERENCES): string {
  const parts = partsOf(input, prefs.timezone);
  return parts ? `${writeDate(parts, prefs.date_format)} ${parts.hour}:${parts.minute}` : String(input);
}

/** How a moment is written for a person: "11/11/2026 | 03:45 PM" (dd/mm/yyyy | hh:mm AM/PM) in the time zone of the organization's country - never UTC.
 *  The same text on the server and in the browser. An unreadable value is returned as it was. */
export function formatStamp(input: string | Date, timeZone: string): string {
  const parts = partsOf(input, timeZone);
  if (!parts) return String(input);
  const hour = Number(parts.hour);
  const twelve = String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, "0");
  return `${parts.day}/${parts.month}/${parts.year} | ${twelve}:${parts.minute} ${hour < 12 ? "AM" : "PM"}`;
}

const SEPARATORS: Record<NumberFormat, { group: string; decimal: string }> = {
  comma_dot: { group: ",", decimal: "." },
  dot_comma: { group: ".", decimal: "," },
  space_comma: { group: " ", decimal: "," },
  indian: { group: ",", decimal: "." },
};

/** An exact decimal string ("1234567.5") written with the organization's separators. Digits are never rounded or dropped. `minFraction`
 *  pads with zeros ("12" -> "12.00"). Anything that is not a plain decimal is returned as it was. */
export function formatDecimal(value: string | number, prefs: Preferences = DEFAULT_PREFERENCES, minFraction = 0): string {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return String(value);
  const [, sign, whole, fraction = ""] = match;
  const { group, decimal } = SEPARATORS[prefs.number_format];
  let grouped: string;
  if (prefs.number_format === "indian" && whole.length > 3) {
    const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, group);
    grouped = `${head}${group}${whole.slice(-3)}`;
  } else {
    grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  }
  const digits = fraction.length < minFraction ? fraction.padEnd(minFraction, "0") : fraction;
  return `${sign}${grouped}${digits ? decimal + digits : ""}`;
}
