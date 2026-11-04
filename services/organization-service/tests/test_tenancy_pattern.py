"""The reusable tenant-scoping helpers (app/tenancy.py), proven on a throwaway table with two tenants.

Future Inventory/Sales/Finance services copy these helpers; this is the test pattern to copy with them.
The table exists only inside the test database for the duration of each test.
"""
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import String, UniqueConstraint, Uuid, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.auth import TenantContext
from app.tenancy import (
    TenantOwnedMixin,
    create_for_tenant,
    delete_scoped,
    get_scoped,
    get_scoped_or_404,
    scoped_select,
    update_scoped,
)


class _Base(DeclarativeBase):
    pass


class Note(TenantOwnedMixin, _Base):
    """Stand-in for a future Product / Order / Invoice."""

    __tablename__ = "tenant_pattern_notes"
    __table_args__ = (UniqueConstraint("organization_id", "title", name="uq_notes_org_title"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(100), nullable=False)


def tenant(name):
    return TenantContext(organization_id=uuid.uuid4(), user_id=name, email=f"{name}@example.org", full_name=name)


@pytest.fixture
def notes_table(engine):
    _Base.metadata.create_all(engine)
    yield
    _Base.metadata.drop_all(engine)


@pytest.fixture
def world(notes_table, session_factory):
    """Two tenants, each owning two notes."""
    a, b = tenant("alpha"), tenant("beta")
    with session_factory() as db:
        for t in (a, b):
            for title in ("first", "second"):
                db.add(create_for_tenant(Note, t, title=f"{t.user_id}-{title}"))
        db.commit()
    return a, b


def titles(session_factory, org=None):
    with session_factory() as db:
        query = select(Note.title).order_by(Note.title)
        if org is not None:
            query = query.where(Note.organization_id == org.organization_id)
        return list(db.scalars(query))


def test_the_mixin_makes_organization_id_required_and_indexed():
    column = Note.__table__.c.organization_id
    assert column.nullable is False
    assert any("organization_id" in [c.name for c in index.columns] for index in Note.__table__.indexes)


def test_new_rows_take_their_organization_from_the_tenant_context(session_factory, world):
    a, _ = world
    with session_factory() as db:
        note = create_for_tenant(Note, a, title="created")
        db.add(note)
        db.commit()
        assert note.organization_id == a.organization_id


def test_an_organization_id_from_a_request_is_refused(world):
    a, b = world
    with pytest.raises(ValueError, match="never from the request"):
        create_for_tenant(Note, a, title="x", organization_id=b.organization_id)


def test_listing_only_returns_the_tenants_rows(session_factory, world):
    a, b = world
    with session_factory() as db:
        assert sorted(n.title for n in db.scalars(scoped_select(Note, a))) == ["alpha-first", "alpha-second"]
        assert sorted(n.title for n in db.scalars(scoped_select(Note, b))) == ["beta-first", "beta-second"]
    assert "organization_id" in str(scoped_select(Note, a))  # the filter is really in the SQL


def test_guessing_another_tenants_id_finds_nothing(session_factory, world):
    a, b = world
    with session_factory() as db:
        betas = list(db.scalars(scoped_select(Note, b)))
        own = list(db.scalars(scoped_select(Note, a)))[0]
        assert get_scoped(db, Note, a, own.id) is not None
        assert get_scoped(db, Note, a, betas[0].id) is None  # exists, but not theirs

        with pytest.raises(HTTPException) as foreign:
            get_scoped_or_404(db, Note, a, betas[0].id, "Note")
        with pytest.raises(HTTPException) as nothing:
            get_scoped_or_404(db, Note, a, uuid.uuid4(), "Note")
        # another tenant's row and a row that does not exist are indistinguishable
        assert foreign.value.status_code == 404
        assert (foreign.value.status_code, foreign.value.detail) == (nothing.value.status_code, nothing.value.detail)


def test_updates_cannot_touch_or_move_another_tenants_rows(session_factory, world):
    a, b = world
    with session_factory() as db:
        mine = db.scalars(scoped_select(Note, a)).first()
        theirs = db.scalars(scoped_select(Note, b)).first()
        assert update_scoped(db, Note, a, mine.id, title="renamed") is True
        assert update_scoped(db, Note, a, theirs.id, title="hijacked") is False
        with pytest.raises(ValueError, match="can never be changed"):
            update_scoped(db, Note, a, mine.id, organization_id=b.organization_id)  # no moving rows between tenants
        db.commit()
    assert "renamed" in titles(session_factory, a) and "hijacked" not in titles(session_factory, b)
    assert len(titles(session_factory, b)) == 2


def test_deletes_cannot_touch_another_tenants_rows(session_factory, world):
    a, b = world
    with session_factory() as db:
        mine = db.scalars(scoped_select(Note, a)).first()
        theirs = db.scalars(scoped_select(Note, b)).first()
        assert delete_scoped(db, Note, a, theirs.id) is False
        assert delete_scoped(db, Note, a, mine.id) is True
        assert delete_scoped(db, Note, a, mine.id) is False  # already gone
        db.commit()
    assert len(titles(session_factory, a)) == 1 and len(titles(session_factory, b)) == 2


def test_uniqueness_is_per_tenant(session_factory, world):
    a, b = world
    with session_factory() as db:
        db.add(create_for_tenant(Note, b, title="alpha-first"))  # another tenant may reuse the same title
        db.commit()
        db.add(create_for_tenant(Note, a, title="alpha-first"))  # but not twice within one tenant
        with pytest.raises(IntegrityError):
            db.commit()
