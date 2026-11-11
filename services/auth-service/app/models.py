import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, LargeBinary, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # An organization administrator must always belong to an organization.
        CheckConstraint(
            "role <> 'organization-admin' OR organization_id IS NOT NULL",
            name="org_admin_requires_org",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="user", server_default="user")
    # Owned by the Organization Service (a separate database), so this is a plain id, not a foreign key.
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # First-time onboarding: NULL until the administrator has confirmed their own profile. The authoritative record
    # (never a cookie or browser storage).
    profile_setup_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # The person's own colour theme for the portals: identifiers of the approved palettes only (see app/theme.py). NULL = never chosen (the default theme).
    theme_background: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    theme_accent: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # The person's own arrangement of the widgets on their portal's home page: identifiers and a revision only (see app/dashboard_layout.py). NULL = never customised.
    dashboard_layout: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    # The person's own profile picture: a small square PNG re-encoded from the decoded upload (see app/avatar.py). NULL = none (the portals show the initials).
    avatar_png: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
