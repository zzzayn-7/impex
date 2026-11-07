def like_pattern(term: str) -> str:
    """A contains-pattern for ILIKE where the user's % and _ are matched literally (use with escape="\\\\")."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"
