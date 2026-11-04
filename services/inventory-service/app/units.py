"""Units of measurement and whether a quantity in that unit may have a fractional part.

Units are free text on a product ("pcs", "kg", ...), so the rule is deliberately conservative: only units known
to measure a continuous quantity (weight, volume, length, area) accept fractions. EVERYTHING ELSE, including a
unit nobody has heard of, is counted in whole numbers, so "2.5 pcs" or "0.3 boxes" can never be stored.
The Inventory Service tells the portal the answer (`unit_allows_fractions` on a product), so the browser never
keeps its own copy of this list.
"""

DIVISIBLE_UNITS = frozenset(
    {
        # weight
        "kg", "g", "mg", "t", "ton", "tons", "tonne", "tonnes", "lb", "lbs", "oz",
        # volume
        "l", "ml", "cl", "litre", "litres", "liter", "liters", "gal",
        # length
        "m", "cm", "mm", "km", "ft", "yd", "in",
        # area / volume
        "m2", "m²", "sqm", "m3", "m³", "cbm",
    }
)


def normalize_unit(unit: str) -> str:
    return unit.strip().lower()


def allows_fractions(unit: str) -> bool:
    return normalize_unit(unit) in DIVISIBLE_UNITS
