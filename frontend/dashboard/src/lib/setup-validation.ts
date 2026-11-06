// First-time setup: the checks shared by the wizard (instant feedback) and the server routes (the real check before anything is
// sent on). The services repeat every one of them and are the final authority; these only keep obviously bad input from travelling.
// Unicode-aware, built with RegExp() because the project's TypeScript target does not allow /\p{...}/u literals.

const LETTER = new RegExp("\\p{L}", "u");
const LETTER_OR_NUMBER = new RegExp("[\\p{L}\\p{N}]", "u");
const NAME_CHARACTER = new RegExp("^[\\p{L}\\p{M} .'’-]+$", "u");
const COMPANY_CHARACTER = new RegExp("^[\\p{L}\\p{N}\\p{M} .,'’()\\-/+:;!@#&\"]+$", "u");

export const collapseSpaces = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

/** The company name as it will be saved, or an error message. 2-120 characters of letters, digits, accents, spaces and . , ' ( ) - / & + : ; ! @ # */
export function checkCompanyName(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter your company name." };
  const name = collapseSpaces(value.normalize("NFC"));
  if (name.length < 2 || name.length > 120) return { ok: false, message: "The company name must be 2 to 120 characters." };
  if (!COMPANY_CHARACTER.test(name) || !LETTER_OR_NUMBER.test(name)) return { ok: false, message: "Use letters, numbers, spaces and . , ' ( ) - / & + : ; ! @ # only." };
  return { ok: true, value: name };
}

/** The administrator's full name as it will be saved, or an error message. 2-100 characters of letters (any alphabet), spaces, . ' ’ - */
export function checkFullName(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "Enter your full name." };
  const name = collapseSpaces(value.normalize("NFC"));
  if (name.length < 2 || name.length > 100) return { ok: false, message: "Your name must be 2 to 100 characters." };
  if (!NAME_CHARACTER.test(name) || !LETTER.test(name)) return { ok: false, message: "Use letters, spaces, apostrophes, hyphens and full stops only." };
  return { ok: true, value: name };
}

/** Up to two capital letters for the company monogram: the fallback when no valid logo exists. */
export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => LETTER_OR_NUMBER.test(w))
    .slice(0, 2)
    .map((w) => (w.match(LETTER_OR_NUMBER)?.[0] ?? "").toUpperCase());
  return letters.join("") || "IX";
}

// The logo the browser may send. The Organization Service checks the real content, size and dimensions; this only avoids a
// pointless upload.
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_ACCEPT = LOGO_TYPES.join(",");

export function checkLogoFile(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES.includes(file.type)) return "Use a PNG, JPEG or WebP image.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > LOGO_MAX_BYTES) return "The logo must be 2 MB or smaller.";
  return null;
}
