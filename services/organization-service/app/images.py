"""Company logo validation and normalization.

The browser's claims (file name, Content-Type) are never trusted. The bytes are DECODED with Pillow, and the file is accepted
only if they really are a PNG, JPEG or WebP picture of a sane size. What is stored is not the upload but a fresh PNG re-encoded
from the decoded pixels, so metadata (EXIF, GPS, text chunks), appended data, polyglot tricks and anything that is not pixels
are gone. SVG (which can carry script), GIF, BMP, PDF, ICO and every other type are refused.

Limits (override with environment variables):
    LOGO_MAX_BYTES        upload size, default 2 MiB
    LOGO_MIN_PIXELS       shortest side, default 64
    LOGO_MAX_PIXELS       longest side of the UPLOAD, default 4096
    LOGO_STORE_PIXELS     the stored logo is shrunk to fit this square, default 1024
"""
import io
import os
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

ALLOWED_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
ALLOWED_CONTENT_TYPES = set(ALLOWED_FORMATS.values())
STORED_CONTENT_TYPE = "image/png"


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


class LogoRejected(ValueError):
    """The upload is not an acceptable logo. `code` is stable for clients; the message is safe to show."""

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code, self.message, self.status_code = code, message, status_code


@dataclass(frozen=True)
class Logo:
    data: bytes
    width: int
    height: int


def max_bytes() -> int:
    return _int_env("LOGO_MAX_BYTES", 2 * 1024 * 1024)


def normalize_logo(data: bytes, declared_content_type: str) -> Logo:
    limit = max_bytes()
    if len(data) > limit:
        raise LogoRejected("file_too_large", f"The logo must be {limit // (1024 * 1024)} MB or smaller.", 413)
    if not data:
        raise LogoRejected("empty_file", "The file is empty.")
    if (declared_content_type or "").split(";")[0].strip().lower() not in ALLOWED_CONTENT_TYPES:
        raise LogoRejected("unsupported_type", "Use a PNG, JPEG or WebP image.", 415)

    min_side, max_side, store_side = _int_env("LOGO_MIN_PIXELS", 64), _int_env("LOGO_MAX_PIXELS", 4096), _int_env("LOGO_STORE_PIXELS", 1024)
    # The size announced in the header is checked BEFORE any pixel is decoded, so a decompression bomb (a tiny file that expands to
    # gigabytes) is refused without being expanded. (Pillow's own global limit is left alone: changing it is not thread-safe.)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise LogoRejected("unsupported_type", "Use a PNG, JPEG or WebP image.", 415)
            width, height = probe.size
            if min(width, height) < min_side:
                raise LogoRejected("too_small", f"The logo must be at least {min_side} x {min_side} pixels.")
            if max(width, height) > max_side:
                raise LogoRejected("too_large_dimensions", f"The logo must be at most {max_side} x {max_side} pixels.")
            probe.verify()  # structural check of the file
        # verify() leaves the image unusable: open again and fully decode the pixels (catches truncated / corrupt files)
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            image = ImageOps.exif_transpose(image)  # honour the photo's rotation before the metadata is dropped
            has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
            pixels = image.convert("RGBA" if has_alpha else "RGB")
    except LogoRejected:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, SyntaxError, ValueError, EOFError, MemoryError):
        raise LogoRejected("invalid_image", "This file is not a valid PNG, JPEG or WebP image.")

    if max(pixels.size) > store_side:
        pixels.thumbnail((store_side, store_side), Image.LANCZOS)
    out = io.BytesIO()
    pixels.save(out, format="PNG", optimize=True)  # a brand-new file: no metadata, nothing appended
    return Logo(data=out.getvalue(), width=pixels.size[0], height=pixels.size[1])
