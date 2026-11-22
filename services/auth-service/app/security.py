import hashlib
import hmac
import secrets
import string
from typing import List


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$")
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 200_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


MIN_PASSWORD_LENGTH = 12


def password_problems(password: str, email: str) -> List[str]:
    """Reasons a password is too weak for privileged accounts (empty list = acceptable)."""
    problems = []
    if len(password) < MIN_PASSWORD_LENGTH:
        problems.append(f"at least {MIN_PASSWORD_LENGTH} characters")
    if not any(c.islower() for c in password):
        problems.append("a lowercase letter")
    if not any(c.isupper() for c in password):
        problems.append("an uppercase letter")
    if not any(c.isdigit() for c in password):
        problems.append("a digit")
    if all(c.isalnum() for c in password):
        problems.append("a symbol (e.g. ! @ # $ %)")
    local_part = email.split("@")[0]
    if len(local_part) >= 3 and local_part in password.lower():
        problems.append("no part of your email address")
    return problems


# Characters that cannot be mistaken for each other when a person copies a password from an email (no 0/O, 1/l/I) and symbols that survive being pasted anywhere.
_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
_LOWER = "abcdefghijkmnopqrstuvwxyz"
_DIGITS = "23456789"
_SYMBOLS = "!@#$%&*?+="
TEMPORARY_PASSWORD_LENGTH = 16


def generate_temporary_password(email: str = "") -> str:
    """A strong random password from the operating system's secure generator: 16 characters with at least two of each kind, nothing that looks alike, and (checked) nothing that fails the
    portal's own password rules, including "no part of your email address"."""
    rng = secrets.SystemRandom()
    while True:
        chars = [secrets.choice(_UPPER) for _ in range(3)] + [secrets.choice(_LOWER) for _ in range(4)] + [secrets.choice(_DIGITS) for _ in range(3)] + [secrets.choice(_SYMBOLS) for _ in range(2)]
        pool = _UPPER + _LOWER + _DIGITS + _SYMBOLS
        chars += [secrets.choice(pool) for _ in range(TEMPORARY_PASSWORD_LENGTH - len(chars))]
        rng.shuffle(chars)
        password = "".join(chars)
        if not password_problems(password, email):
            return password
