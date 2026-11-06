"""First-time onboarding helper for the live verification scripts.

Every organization created from now on starts with first-time setup PENDING, and every new administrator with their profile
unconfirmed, so the portal sends them to /setup instead of the dashboard. The scripts that verify OTHER features (products, stock,
dispatches, invoices ...) create throwaway organizations and use the portal's pages; for those, the throwaway organization and its
administrators are marked as already set up. verify_onboarding.py is the script that exercises the wizard itself.

Module management (Step 19) works the same way: an organization created from now on has only Inventory enabled, so the throwaway organizations of
the scripts that exercise Purchasing and Sales get all three modules switched on here. verify_modules.py is the script that exercises the
module rules themselves.

Touches only the exact organization id it is given (and that organization's administrators): never a pattern, never anything else.
"""
import re
from typing import Callable

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def mark_setup_complete(psql: Callable[[str, str], str], organization_id: str) -> None:
    if not isinstance(organization_id, str) or not _UUID.match(organization_id):
        raise ValueError(f"refusing to use a non-UUID organization id: {organization_id!r}")
    psql("impex_organizations", f"UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id = '{organization_id}'")
    psql("impex_auth", f"UPDATE users SET profile_setup_completed_at = now() WHERE organization_id = '{organization_id}'")
    enable_modules(psql, organization_id)


def enable_modules(psql: Callable[[str, str], str], organization_id: str, modules=("inventory", "purchasing", "sales")) -> None:
    """Switch these modules on for one throwaway organization (written straight to the Organization Service's table, no history entry)."""
    if not isinstance(organization_id, str) or not _UUID.match(organization_id):
        raise ValueError(f"refusing to use a non-UUID organization id: {organization_id!r}")
    allowed = ("inventory", "purchasing", "sales")
    rows = ", ".join(f"('{organization_id}', '{m}', true, now())" for m in modules if m in allowed)
    psql("impex_organizations", f"INSERT INTO organization_modules (organization_id, module_key, enabled, updated_at) VALUES {rows} ON CONFLICT (organization_id, module_key) DO UPDATE SET enabled = true, updated_at = now()")
