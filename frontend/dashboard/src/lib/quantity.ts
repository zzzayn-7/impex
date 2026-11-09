// The quantity selector's arithmetic. Quantities are ALWAYS decimal strings in this portal (NUMERIC(18,4) on the server): nothing here goes through a
// JavaScript number, so nothing is rounded. A value that is empty or not a plain non-negative decimal counts as 0, so "+" always starts from zero.
// (BigInt() calls, not literals: the project's TypeScript target is below ES2020.)

export const QUANTITY_STEP = "10";

const PLAIN = /^(\d+)(?:\.(\d+))?$/;
const ZERO = BigInt(0);

type Scaled = { n: bigint; scale: number };

/** The value as all its digits (a BigInt) and how many of them are decimals; anything that is not a plain non-negative decimal is 0. */
function scaled(value: string): Scaled {
  const m = PLAIN.exec(value.trim());
  if (!m) return { n: ZERO, scale: 0 };
  const fraction = m[2] ?? "";
  return { n: BigInt(m[1] + fraction), scale: fraction.length };
}

/** a and b brought to the same number of decimals. */
function align(a: Scaled, b: Scaled): { x: bigint; y: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const up = (v: Scaled) => BigInt(v.n.toString() + "0".repeat(scale - v.scale));
  return { x: up(a), y: up(b), scale };
}

function render(n: bigint, scale: number): string {
  const digits = n.toString().padStart(scale + 1, "0");
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

/** value + step ("10" by default), exactly. "" and text count as 0: "" -> "10", "2.5" -> "12.5". */
export function increase(value: string, step: string = QUANTITY_STEP): string {
  const { x, y, scale } = align(scaled(value), scaled(step));
  return render(x + y, scale);
}

/** value - step, never below zero: "25" -> "15", "5" -> "0", "" -> "0". */
export function decrease(value: string, step: string = QUANTITY_STEP): string {
  const { x, y, scale } = align(scaled(value), scaled(step));
  return x <= y ? "0" : render(x - y, scale);
}

/** Is there anything to take away? (Used to disable "-" at zero.) */
export function isZero(value: string): boolean {
  return scaled(value).n === ZERO;
}
