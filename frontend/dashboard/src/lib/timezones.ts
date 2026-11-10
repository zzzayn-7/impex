import { CURRENCY_CODES } from "@/lib/currencies";

// The time zones offered in Settings: the common business ones, as IANA names. The Organization Service accepts any valid IANA zone and is the
// real judge; the list is a fixed one (not read from the browser's runtime) so the server and the browser always render the same options.
export const TIMEZONES: string[] = [
  "UTC",
  "Africa/Cairo", "Africa/Casablanca", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
  "America/Anchorage", "America/Argentina/Buenos_Aires", "America/Bogota", "America/Chicago", "America/Denver", "America/Halifax", "America/Lima", "America/Los_Angeles",
  "America/Mexico_City", "America/New_York", "America/Santiago", "America/Sao_Paulo", "America/Toronto", "America/Vancouver",
  "Asia/Baghdad", "Asia/Bangkok", "Asia/Colombo", "Asia/Dhaka", "Asia/Dubai", "Asia/Hong_Kong", "Asia/Jakarta", "Asia/Jerusalem", "Asia/Karachi", "Asia/Kathmandu",
  "Asia/Kolkata", "Asia/Kuala_Lumpur", "Asia/Manila", "Asia/Riyadh", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Asia/Tashkent", "Asia/Tehran", "Asia/Tokyo",
  "Atlantic/Reykjavik",
  "Australia/Adelaide", "Australia/Brisbane", "Australia/Melbourne", "Australia/Perth", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Athens", "Europe/Berlin", "Europe/Brussels", "Europe/Dublin", "Europe/Istanbul", "Europe/Lisbon", "Europe/London", "Europe/Madrid",
  "Europe/Moscow", "Europe/Paris", "Europe/Rome", "Europe/Stockholm", "Europe/Vienna", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Honolulu",
];

/** The offered zones, plus the organization's current one if it is a valid zone that is not in the list (so it is never lost). */
export function timezoneOptions(current: string): string[] {
  return TIMEZONES.includes(current) ? TIMEZONES : [current, ...TIMEZONES];
}

// The ISO 4217 codes offered as the default currency: all of them (see lib/currencies.ts). The Organization Service validates against the same list.
export const CURRENCY_OPTIONS: string[] = CURRENCY_CODES;

export function currencyOptions(current: string): string[] {
  return CURRENCY_OPTIONS.includes(current) ? CURRENCY_OPTIONS : [current, ...CURRENCY_OPTIONS];
}
