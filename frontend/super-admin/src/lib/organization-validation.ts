// Pure helpers shared by the browser form (instant feedback) and the server route (the real check).

export type OrganizationInput = {
  name: string;
  primaryAdminEmail: string;
  contactEmail: string;
  countryCode: string;
  taxIdentifier: string;
};

export type FieldErrors = Partial<Record<keyof OrganizationInput, string>>;

export type Organization = {
  id: string;
  name: string;
  slug: string;
  country_code: string;
  tax_identifier: string | null;
  contact_email: string;
  primary_admin_email: string | null;
  is_active: boolean;
  created_at: string;
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export function normalizeOrganizationInput(input: OrganizationInput): OrganizationInput {
  return {
    name: input.name.trim().replace(/\s+/g, " "),
    primaryAdminEmail: input.primaryAdminEmail.trim().toLowerCase(),
    contactEmail: input.contactEmail.trim().toLowerCase(),
    countryCode: input.countryCode.trim().toUpperCase(),
    taxIdentifier: input.taxIdentifier.trim(),
  };
}

// Expects normalized input.
export function validateOrganization(input: OrganizationInput): FieldErrors {
  const errors: FieldErrors = {};

  if (input.name.length < 2) errors.name = "Enter the organization name (at least 2 characters).";
  else if (input.name.length > 255) errors.name = "Organization name must be 255 characters or fewer.";

  if (!input.primaryAdminEmail) errors.primaryAdminEmail = "Enter the primary administrator's email.";
  else if (!EMAIL_RE.test(input.primaryAdminEmail) || input.primaryAdminEmail.length > 320)
    errors.primaryAdminEmail = "Enter a valid email address.";

  if (!input.contactEmail) errors.contactEmail = "Enter a contact email.";
  else if (!EMAIL_RE.test(input.contactEmail) || input.contactEmail.length > 320)
    errors.contactEmail = "Enter a valid email address.";

  if (!COUNTRY_RE.test(input.countryCode)) errors.countryCode = "Use a 2-letter country code, e.g. US or DE.";

  if (input.taxIdentifier.length > 100) errors.taxIdentifier = "Tax identifier must be 100 characters or fewer.";

  return errors;
}
