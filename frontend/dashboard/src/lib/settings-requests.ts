// Help & Support requests opened from Settings. The text is FIXED here: a link carries only a key from this list, never text of its own, and
// sending one only opens a ticket. It never changes a company field, a module or anything else: only the Impex team can, deliberately.
export type ChangeKey = "country" | "tax_id" | "slug" | "ownership" | "status" | "other";

export const CHANGE_KEYS: ChangeKey[] = ["country", "tax_id", "slug", "ownership", "status", "other"];

const LABELS: Record<ChangeKey, string> = {
  country: "registered country or jurisdiction",
  tax_id: "tax registration number",
  slug: "organization identifier (slug)",
  ownership: "organization ownership",
  status: "organization status",
  other: "company information",
};

export const isChangeKey = (value: unknown): value is ChangeKey => typeof value === "string" && (CHANGE_KEYS as string[]).includes(value);

export function changeRequestDraft(key: ChangeKey): { subject: string; message: string } {
  const label = LABELS[key];
  return {
    subject: `Request to change our ${label}`,
    message: `We would like to change our ${label}.\n\nCurrent value: \nNew value: \nWhy: `,
  };
}

export const changeRequestHref = (key: ChangeKey) => `/support/new?change=${key}`;
