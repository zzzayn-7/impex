"""A person's own profile picture.

The browser's claims (file name, Content-Type) are never trusted. The bytes are DECODED with Pillow and accepted only if they really are a PNG, JPEG or WebP
picture of a sane size. What is stored is not the upload but a fresh square PNG (centre-cropped, AVATAR_STORE_PIXELS wide) re-encoded from the decoded pixels, so
metadata (EXIF, GPS, text chunks), appended data and polyglot tricks are gone. SVG (which can carry script), GIF, BMP, PDF and every other type are refused.
The picture always belongs to the user the token belongs to: nothing in a request can name another user.

    AVATAR_MAX_BYTES     upload size, default 2 MiB
    AVATAR_MIN_PIXELS    shortest side, default 64
    AVATAR_MAX_PIXELS    longest side of the upload, default 4096
    AVATAR_STORE_PIXELS  the stored picture is a square of this size, default 256
"""
import io
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.models import User

ALLOWED_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _refuse(code: str, message: str, status_code: int = 422) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def normalize_avatar(data: bytes, declared_content_type: Optional[str]) -> bytes:
    limit = _int_env("AVATAR_MAX_BYTES", 2 * 1024 * 1024)
    if len(data) > limit:
        raise _refuse("file_too_large", f"The picture must be {limit // (1024 * 1024)} MB or smaller.", 413)
    if not data:
        raise _refuse("empty_file", "The file is empty.")
    if (declared_content_type or "").split(";")[0].strip().lower() not in ALLOWED_FORMATS.values():
        raise _refuse("unsupported_type", "Use a PNG, JPEG or WebP picture.", 415)
    min_side, max_side, store = _int_env("AVATAR_MIN_PIXELS", 64), _int_env("AVATAR_MAX_PIXELS", 4096), _int_env("AVATAR_STORE_PIXELS", 256)
    try:
        # the size in the header is checked BEFORE any pixel is decoded, so a decompression bomb is refused without being expanded
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise _refuse("unsupported_type", "Use a PNG, JPEG or WebP picture.", 415)
            width, height = probe.size
            if min(width, height) < min_side:
                raise _refuse("too_small", f"The picture must be at least {min_side} x {min_side} pixels.")
            if max(width, height) > max_side:
                raise _refuse("too_large_dimensions", f"The picture must be at most {max_side} x {max_side} pixels.")
            probe.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            image = ImageOps.exif_transpose(image)  # honour the photo's rotation before the metadata is dropped
            has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
            pixels = ImageOps.fit(image.convert("RGBA" if has_alpha else "RGB"), (store, store), Image.LANCZOS)  # a centred square
    except HTTPException:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, SyntaxError, ValueError, EOFError, MemoryError):
        raise _refuse("invalid_image", "This file is not a valid PNG, JPEG or WebP picture.")
    out = io.BytesIO()
    pixels.save(out, format="PNG", optimize=True)  # a brand-new file: no metadata, nothing appended
    return out.getvalue()


def set_avatar(db: Session, user: User, data: bytes, declared_content_type: Optional[str]) -> User:
    user.avatar_png = normalize_avatar(data, declared_content_type)
    user.avatar_updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return user


def clear_avatar(db: Session, user: User) -> User:
    user.avatar_png = None
    user.avatar_updated_at = None
    db.commit()
    db.refresh(user)
    return user
