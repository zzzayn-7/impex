"""A person's own colour theme (background + accent) for the Impex portals.

Only identifiers of the approved palettes are ever stored: never a colour value, CSS or any free text. The portals own the actual colours (their
shared theme library); this module owns WHICH choices are valid, so a browser can never make the service store anything else. The user is always the
one the token belongs to: there is no way to name another user, and Super Admins and organization administrators each keep their own preference.

KEEP IN SYNC with frontend/*/src/lib/theme.ts (BACKGROUNDS and ACCENTS); the portals' tests compare the two lists.
"""
from typing import Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import User

BACKGROUND_IDS: Tuple[str, ...] = ("original", "burgundy", "ice", "graphite", "deep-purple", "deep-steel-blue")
ACCENT_IDS: Tuple[str, ...] = ("pale-butter", "champagne-gold", "muted-copper", "frost-blue", "lavender-mist", "sage-silver", "dusty-rose", "silver-pearl")

DEFAULT_BACKGROUND = "original"  # the original Impex dark slate-teal foundation
DEFAULT_ACCENT = "pale-butter"


def clean_theme(background: object, accent: object) -> Tuple[str, str]:
    """Both identifiers must be exactly one of the approved ones. Anything else is refused and nothing is stored."""
    if not isinstance(background, str) or background not in BACKGROUND_IDS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "invalid_theme", "message": "Choose one of the available backgrounds."})
    if not isinstance(accent, str) or accent not in ACCENT_IDS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "invalid_theme", "message": "Choose one of the available accent colors."})
    return background, accent


def set_theme(db: Session, user: User, background: object, accent: object) -> User:
    user.theme_background, user.theme_accent = clean_theme(background, accent)
    db.commit()
    db.refresh(user)
    return user


def theme_of(user: User) -> Tuple[Optional[str], Optional[str]]:
    """What is saved, but never an identifier that is not (or no longer) approved: an unknown value reads as "not chosen" (the default theme)."""
    background = user.theme_background if user.theme_background in BACKGROUND_IDS else None
    accent = user.theme_accent if user.theme_accent in ACCENT_IDS else None
    return background, accent
