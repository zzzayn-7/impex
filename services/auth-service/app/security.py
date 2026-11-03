import hashlib
import hmac
import secrets
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
