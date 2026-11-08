import { formatDecimal, type Preferences } from "@/lib/format";
import { sumMoney } from "@/lib/sales-browser";

// Pure calculations behind the Organization Dashboard. Everything comes from records the services returned; nothing is invented, estimated or
// extrapolated. Money is summed EXACTLY (integers in units of 0.0001, see sales-browser) and amounts in different currencies are NEVER added
// together: every function that totals money does so per currency. Numbers are only produced (toPlot) to place a point on a chart; every
// value written on the screen is still the exact string.

export type Money = { currency: string; amount: string };

/** Amounts added up per currency, one row per currency, sorted by currency code. */
export function totalsByCurrency(rows: Money[]): Money[] {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (!/^[A-Z]{3}$/.test(row.currency)) continue;
    grouped.set(row.currency, [...(grouped.get(row.currency) ?? []), row.amount]);
  }
  return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amounts]) => ({ currency, amount: sumMoney(amounts) }));
}

/** The currency a single-currency chart or headline uses: the organization's default when it has data in it, otherwise the one with the most rows. */
export function primaryCurrency(rows: { currency: string }[], preferred: string): string | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.currency === preferred)) return preferred;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export const amountOf = (totals: Money[], currency: string | null): string => totals.find((t) => t.currency === currency)?.amount ?? "0.0000";

// ---- calendar helpers (on plain YYYY-MM-DD strings: no time zone surprises) ------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** The last `count` calendar months, oldest first, ending with the month of `todayIso`: ["2026-06", ..., "2026-11"]. */
export function lastMonths(todayIso: string, count: number): string[] {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(todayIso);
  if (!match) return [];
  let year = Number(match[1]);
  let month = Number(match[2]);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.unshift(`${year}-${pad(month)}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return keys;
}

export const monthLabel = (key: string): string => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;

/** The first day of the first month of `lastMonths`, as the `date_from` of a list request. */
export const startOfMonths = (months: string[]): string => (months.length ? `${months[0]}-01` : "");

/** The last `count` days, oldest first, ending with `todayIso`. */
export function lastDays(todayIso: string, count: number): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayIso);
  if (!match) return [];
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000);
    days.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  return days;
}

/** The calendar day (YYYY-MM-DD) of an instant in the organization's time zone. */
export function dayInZone(instant: string, timezone: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)) parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return null;
  }
}

// ---- series -----------------------------------------------------------------------------------------------------------------------------

export type Dated = { date: string; currency: string; amount: string };

/** For one currency: the exact total of the rows falling in each of `months` ("YYYY-MM"), in the same order. Rows outside the months are ignored. */
export function monthlyTotals(rows: Dated[], months: string[], currency: string): string[] {
  return months.map((month) => sumMoney(rows.filter((r) => r.currency === currency && r.date.slice(0, 7) === month).map((r) => r.amount)));
}

export type MovementLike = { movement_type: string; created_at: string };
export type DayActivity = { day: string; added: number; removed: number };

/** How many stock movements of each kind happened on each of `days` (movements, not quantities: units differ, so quantities cannot be added). */
export function movementActivity(movements: MovementLike[], days: string[], timezone: string): DayActivity[] {
  const byDay = new Map<string, DayActivity>(days.map((day) => [day, { day, added: 0, removed: 0 }]));
  for (const m of movements) {
    const day = dayInZone(m.created_at, timezone);
    const bucket = day ? byDay.get(day) : undefined;
    if (!bucket) continue;
    if (m.movement_type === "in" || m.movement_type === "opening") bucket.added += 1;
    else if (m.movement_type === "out") bucket.removed += 1;
  }
  return days.map((day) => byDay.get(day)!);
}

/** A decimal string as a number, ONLY to position it on a chart. Never displayed. */
export const toPlot = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** An exact amount written with the organization's separators: trailing zeros beyond 2 decimals are dropped, nothing is ever rounded. */
export function formatAmount(amount: string, prefs: Preferences): string {
  const match = /^(-?\d+)(?:\.(\d*))?$/.exec(amount);
  if (!match) return amount;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return formatDecimal(`${match[1]}${fraction ? "." + fraction : ""}`, prefs, 2);
}
