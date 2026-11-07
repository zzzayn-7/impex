import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from "@/lib/format";
import { fetchTenantOrganization } from "@/lib/organization";

/** The organization's own preferences, read with the administrator's token. When the Organization Service cannot answer, the plain defaults
 *  (what the portal always used): a page that only wants to format a date or pre-fill a currency never fails because of it. */
export async function loadPreferences(token: string): Promise<Preferences> {
  const result = await fetchTenantOrganization(token);
  return result.ok ? normalizePreferences(result.organization) : DEFAULT_PREFERENCES;
}
