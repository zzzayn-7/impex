// INSTALLMENTS of a sales invoice: pay an order in 2 to 5 parts, one every N days / weeks / months. The Sales Service makes the invoices and works out the amounts and dates; this file
// only checks what the person typed and previews the amounts the same way the service splits them (equal parts to the cent, the last one takes what is left over).

export type InstallmentUnit = "days" | "weeks" | "months";
export type InstallmentPlan = { count: number; every: number; unit: InstallmentUnit };

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 5;
export const UNIT_LIMITS: Record<InstallmentUnit, number> = { days: 365, weeks: 52, months: 12 };
export const UNIT_LABELS: Record<InstallmentUnit, string> = { days: "Days", weeks: "Weeks", months: "Months" };

const isUnit = (value: unknown): value is InstallmentUnit => value === "days" || value === "weeks" || value === "months";

/** The plan if `input` is a whole, in-range plan; null otherwise. Used by the portal route and by the form. */
export function parsePlan(input: unknown): InstallmentPlan | null {
  if (typeof input !== "object" || input === null) return null;
  const { count, every, unit } = input as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isInteger(count) || count < MIN_INSTALLMENTS || count > MAX_INSTALLMENTS) return null;
  if (!isUnit(unit)) return null;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > UNIT_LIMITS[unit]) return null;
  return { count, every, unit };
}

const toUnits = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(4, "0").slice(0, 4));
};
const fromUnits = (units: bigint): string => {
  const digits = units.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
};

/** The amount of each installment, exactly (no floating point): equal parts to the cent, the last one takes the leftover cents, and together they are always the total. */
export function splitInstallments(total: string, count: number): string[] {
  const units = toUnits(total);
  const cent = BigInt(100);
  const part = (units / BigInt(count) / cent) * cent;
  const parts = Array.from({ length: count - 1 }, () => part);
  parts.push(units - part * BigInt(count - 1));
  return parts.map(fromUnits);
}
