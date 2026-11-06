"""Exact-ID cleanup shared by the verification scripts.

A verification run records the id of every row it creates. Cleanup deletes ONLY those ids, never by a name
pattern (a LIKE filter can match records from an earlier aborted run, or real data that merely looks similar).
"""
import re
from typing import Callable, Iterable, List

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

PsqlFn = Callable[[str, str], str]


class CreatedIds:
    """Collects the ids a run creates, per table. Anything that is not a UUID is ignored (it cannot be a row we made)."""

    def __init__(self) -> None:
        self._ids: dict = {}

    def add(self, table: str, value) -> None:
        if isinstance(value, str) and _UUID.match(value):
            self._ids.setdefault(table, [])
            if value not in self._ids[table]:
                self._ids[table].append(value)

    def get(self, table: str) -> List[str]:
        return list(self._ids.get(table, []))


def _in_list(ids: Iterable[str]) -> str:
    quoted = []
    for value in ids:
        if not _UUID.match(value):  # defensive: these values are interpolated into SQL
            raise ValueError(f"refusing to use a non-UUID in cleanup: {value!r}")
        quoted.append(f"'{value}'")
    return ", ".join(quoted)


def delete_exact(psql: PsqlFn, database: str, table: str, ids: List[str], column: str = "id", *, ledger: bool = False) -> str:
    """DELETE ... WHERE <column> IN (exact ids), then report how many of those rows still exist.

    `ledger=True` is for the append-only stock ledger: deletes are blocked by a database trigger unless the
    transaction sets app.allow_ledger_maintenance (an out-of-band maintenance switch the application never uses).
    """
    if not ids:
        return "0"
    id_list = _in_list(ids)
    # An organization's module history is append-only (a trigger refuses to delete it), and is removed with the organization by cascade:
    # that needs the same out-of-band maintenance switch, which the application itself never sets.
    ledger = ledger or table == "organizations"
    if ledger:
        psql(database, f"BEGIN; SET LOCAL app.allow_ledger_maintenance = 'on'; DELETE FROM {table} WHERE {column} IN ({id_list}); COMMIT;")
    else:
        psql(database, f"DELETE FROM {table} WHERE {column} IN ({id_list})")
    return psql(database, f"SELECT count(*) FROM {table} WHERE {column} IN ({id_list})")
