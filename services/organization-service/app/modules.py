"""Module entitlements: which business modules an organization may use.

The Organization Service OWNS this decision. Each business service (Inventory, Purchasing, Sales) asks for it with the caller's own
token (it is part of GET /api/v1/tenant/organization) and enforces it itself; a browser's menu is only a convenience.

Registry rules:
  * Authentication, Organization Management, Onboarding and Help & Support are PERMANENT platform capabilities: they are not
    modules, cannot be switched off, and nothing here can reach them.
  * Purchasing and Sales REQUIRE Inventory (they read products and move stock through it).
  * Finance (the Finance Service: accounts, journal, expenses) is available to enable, but never on by default: only a Super Admin enables it,
    organization by organization. It needs no other module (it can also record manual entries), though its automatic postings come from Sales and Purchasing.
  * An organization created from now on starts with Inventory enabled and the optional modules disabled.
    Organizations that existed when this was introduced keep everything they could use (migration 0005).
"""
import uuid
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple

MODULE_KEYS = ("inventory", "purchasing", "sales", "finance")


@dataclass(frozen=True)
class ModuleDef:
    key: str
    name: str
    description: str
    features: Tuple[str, ...]
    requires: Tuple[str, ...] = ()
    available: bool = True
    default_for_new: bool = False


REGISTRY: Dict[str, ModuleDef] = {
    "inventory": ModuleDef(
        "inventory", "Inventory", "Products and stock, with scanning and a full movement history.",
        ("Products", "Stock", "Scanning", "Movements"), default_for_new=True,
    ),
    "purchasing": ModuleDef(
        "purchasing", "Purchasing", "Buying from suppliers and receiving the goods into stock.",
        ("Suppliers", "Purchase Orders", "Goods Receipts"), requires=("inventory",),
    ),
    "sales": ModuleDef(
        "sales", "Sales", "Selling to clients: delivery lists, dispatches from stock, invoices and payments.",
        ("Clients", "Delivery Lists", "Dispatches", "Invoices and Payments"), requires=("inventory",),
    ),
    "finance": ModuleDef(
        "finance", "Finance", "Chart of accounts, double-entry journal and expenses, with entries posted from your issued invoices, payments and goods receipts.",
        ("Accounts", "Expenses", "Journal Entries", "Financial Overview"),
    ),
}
assert tuple(REGISTRY) == MODULE_KEYS

# Always on, for everyone. They are shown to the Super Admin so it is clear they cannot be disabled.
PERMANENT: Tuple[Tuple[str, str, str], ...] = (
    ("authentication", "Authentication", "Sign-in, sessions and roles."),
    ("organization", "Organization Management", "The organization, its administrators and its settings."),
    ("onboarding", "Onboarding", "First-time company and administrator setup."),
    ("support", "Help & Support", "Writing to the Impex team. Always available, whatever is enabled."),
)


def default_enabled() -> Dict[str, bool]:
    """What a module is when nothing has been recorded for it: Inventory only."""
    return {key: definition.default_for_new and definition.available for key, definition in REGISTRY.items()}


def effective(enabled: Dict[str, bool]) -> Set[str]:
    """The modules an organization can actually use: enabled, available, and with every module it requires also usable.

    The rules of the Super Admin API make 'enabled without its requirements' impossible; this makes it harmless even if the data
    were ever edited by hand."""
    usable: Set[str] = set()
    changed = True
    while changed:
        changed = False
        for key, definition in REGISTRY.items():
            if key in usable or not definition.available or not enabled.get(key):
                continue
            if all(dep in usable for dep in definition.requires):
                usable.add(key)
                changed = True
    return usable


@dataclass(frozen=True)
class Blocker:
    code: str
    module: str
    message: str
    counts: Optional[List[dict]] = None

    def as_dict(self) -> dict:
        out = {"code": self.code, "module": self.module, "message": self.message}
        if self.counts is not None:
            out["counts"] = self.counts
        return out


def validate_target(current: Dict[str, bool], changes: Dict[str, bool]) -> Tuple[Dict[str, bool], List[Blocker]]:
    """Dependency and availability rules for a requested change. Returns the resulting state and the blockers (empty = allowed).

    `changes` holds only modules whose value differs from `current`."""
    target = {**current, **changes}
    blockers: List[Blocker] = []
    for key, wanted in changes.items():
        definition = REGISTRY[key]
        if wanted and not definition.available:
            blockers.append(Blocker("module_unavailable", key, f"{definition.name} is planned and cannot be enabled yet."))
            continue
        if wanted:
            for dep in definition.requires:
                if not target.get(dep):
                    blockers.append(Blocker("requires", key, f"{definition.name} requires {REGISTRY[dep].name}. Enable {REGISTRY[dep].name} first."))
        else:
            dependants = [REGISTRY[k].name for k, d in REGISTRY.items() if key in d.requires and target.get(k)]
            if dependants:
                blockers.append(Blocker("required_by", key, f"{definition.name} cannot be disabled while {' and '.join(dependants)} {'is' if len(dependants) == 1 else 'are'} enabled. Disable {'it' if len(dependants) == 1 else 'them'} first."))
    return target, blockers


def new_batch_id() -> uuid.UUID:
    return uuid.uuid4()


def known(keys: Iterable[str]) -> bool:
    return all(key in REGISTRY for key in keys)
