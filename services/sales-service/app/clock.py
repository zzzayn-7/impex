"""The one place the Sales Service asks what time it is for business rules (the 24-hour Delivered History window, completion times).

Tests replace `now` to move time deterministically; nothing else should call datetime.now() for these rules.
"""
from datetime import datetime, timezone


def now() -> datetime:
    return datetime.now(timezone.utc)
