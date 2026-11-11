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

/** The time zone of the country a business is in, for the countries organizations register under (the setup form starts from it; the person can change it). Anything not listed starts at UTC. */
export const COUNTRY_TIMEZONES: Record<string, string> = {
  PK: "Asia/Karachi", IN: "Asia/Kolkata", BD: "Asia/Dhaka", LK: "Asia/Colombo", NP: "Asia/Kathmandu", AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Riyadh", KW: "Asia/Riyadh", IQ: "Asia/Baghdad",
  IR: "Asia/Tehran", IL: "Asia/Jerusalem", TR: "Europe/Istanbul", CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur",
  ID: "Asia/Jakarta", TH: "Asia/Bangkok", PH: "Asia/Manila", UZ: "Asia/Tashkent", EG: "Africa/Cairo", MA: "Africa/Casablanca", NG: "Africa/Lagos", KE: "Africa/Nairobi", ZA: "Africa/Johannesburg",
  GB: "Europe/London", IE: "Europe/Dublin", DE: "Europe/Berlin", FR: "Europe/Paris", ES: "Europe/Madrid", PT: "Europe/Lisbon", IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels",
  CH: "Europe/Zurich", AT: "Europe/Vienna", SE: "Europe/Stockholm", PL: "Europe/Warsaw", GR: "Europe/Athens", RU: "Europe/Moscow", IS: "Atlantic/Reykjavik",
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago", CO: "America/Bogota", PE: "America/Lima",
  AU: "Australia/Sydney", NZ: "Pacific/Auckland",
};

/** Where the setup form starts: the zone the organization already has, or the one of its country, or UTC. */
export const startingTimezone = (current: string | null | undefined, countryCode: string | null | undefined): string =>
  current && current !== "UTC" ? current : COUNTRY_TIMEZONES[(countryCode ?? "").toUpperCase()] ?? "UTC";

export const isKnownTimezone = (value: unknown): value is string => typeof value === "string" && TIMEZONES.includes(value);

/** The country of each offered zone: a person looks for "Pakistan", not for "Asia". */
const ZONE_COUNTRY: Record<string, string> = {
  "Africa/Cairo": "Egypt",
  "Africa/Casablanca": "Morocco",
  "Africa/Johannesburg": "South Africa",
  "Africa/Lagos": "Nigeria",
  "Africa/Nairobi": "Kenya",
  "America/Anchorage": "United States",
  "America/Argentina/Buenos_Aires": "Argentina",
  "America/Bogota": "Colombia",
  "America/Chicago": "United States",
  "America/Denver": "United States",
  "America/Halifax": "Canada",
  "America/Lima": "Peru",
  "America/Los_Angeles": "United States",
  "America/Mexico_City": "Mexico",
  "America/New_York": "United States",
  "America/Santiago": "Chile",
  "America/Sao_Paulo": "Brazil",
  "America/Toronto": "Canada",
  "America/Vancouver": "Canada",
  "Asia/Baghdad": "Iraq",
  "Asia/Bangkok": "Thailand",
  "Asia/Colombo": "Sri Lanka",
  "Asia/Dhaka": "Bangladesh",
  "Asia/Dubai": "United Arab Emirates",
  "Asia/Hong_Kong": "Hong Kong",
  "Asia/Jakarta": "Indonesia",
  "Asia/Jerusalem": "Israel",
  "Asia/Karachi": "Pakistan",
  "Asia/Kathmandu": "Nepal",
  "Asia/Kolkata": "India",
  "Asia/Kuala_Lumpur": "Malaysia",
  "Asia/Manila": "Philippines",
  "Asia/Riyadh": "Saudi Arabia",
  "Asia/Seoul": "South Korea",
  "Asia/Shanghai": "China",
  "Asia/Singapore": "Singapore",
  "Asia/Tashkent": "Uzbekistan",
  "Asia/Tehran": "Iran",
  "Asia/Tokyo": "Japan",
  "Atlantic/Reykjavik": "Iceland",
  "Australia/Adelaide": "Australia",
  "Australia/Brisbane": "Australia",
  "Australia/Melbourne": "Australia",
  "Australia/Perth": "Australia",
  "Australia/Sydney": "Australia",
  "Europe/Amsterdam": "Netherlands",
  "Europe/Athens": "Greece",
  "Europe/Berlin": "Germany",
  "Europe/Brussels": "Belgium",
  "Europe/Dublin": "Ireland",
  "Europe/Istanbul": "Turkey",
  "Europe/Lisbon": "Portugal",
  "Europe/London": "United Kingdom",
  "Europe/Madrid": "Spain",
  "Europe/Moscow": "Russia",
  "Europe/Paris": "France",
  "Europe/Rome": "Italy",
  "Europe/Stockholm": "Sweden",
  "Europe/Vienna": "Austria",
  "Europe/Warsaw": "Poland",
  "Europe/Zurich": "Switzerland",
  "Pacific/Auckland": "New Zealand",
  "Pacific/Honolulu": "United States",
};

/** "Pakistan / Karachi" (country / city) - never "Asia/Karachi" (continent / city). A zone without a known country keeps its own name; UTC is just "UTC". */
export function timezoneLabel(zone: string): string {
  const country = ZONE_COUNTRY[zone];
  if (!country) return zone === "UTC" ? "UTC" : zone.replace(/_/g, " ");
  const city = zone.split("/").pop()!.replace(/_/g, " ");
  return `${country} / ${city}`;
}

/** The choices for a time zone dropdown, UTC first then by country and city (the person types a country or a city to find one). The VALUE stays the IANA name. */
export function timezoneChoices(current: string): { value: string; label: string }[] {
  const all = timezoneOptions(current).map((value) => ({ value, label: timezoneLabel(value) }));
  return [...all.filter((z) => z.value === "UTC"), ...all.filter((z) => z.value !== "UTC").sort((a, b) => a.label.localeCompare(b.label))];
}

/** The offered zones, plus the organization's current one if it is a valid zone that is not in the list (so it is never lost). */
export function timezoneOptions(current: string): string[] {
  return TIMEZONES.includes(current) ? TIMEZONES : [current, ...TIMEZONES];
}

// The ISO 4217 codes offered as the default currency: all of them (see lib/currencies.ts). The Organization Service validates against the same list.
export const CURRENCY_OPTIONS: string[] = CURRENCY_CODES;

export function currencyOptions(current: string): string[] {
  return CURRENCY_OPTIONS.includes(current) ? CURRENCY_OPTIONS : [current, ...CURRENCY_OPTIONS];
}
