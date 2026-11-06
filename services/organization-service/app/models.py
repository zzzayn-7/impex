import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Identity, Index, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Organization(Base):
    __tablename__ = "organizations"
    __table_args__ = (
        CheckConstraint("setup_status IN ('pending', 'in_progress', 'completed')", name="setup_status_valid"),
        CheckConstraint("setup_status <> 'completed' OR setup_completed_at IS NOT NULL", name="completed_has_a_time"),
        CheckConstraint("(logo_storage_key IS NULL) = (logo_content_type IS NULL)", name="logo_key_and_type_together"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    country_code: Mapped[str] = mapped_column(String(10), nullable=False)
    tax_identifier: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    contact_email: Mapped[str] = mapped_column(String(320), nullable=False)
    # Filled in by the invitation flow in a later step.
    primary_admin_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # First-time setup (see app/onboarding.py). New organizations start 'pending'; organizations that existed when this was
    # introduced were migrated as 'completed' so nobody was locked out.
    setup_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default=text("'pending'"))
    setup_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # The Auth Service user who completed it (a plain id: users live in another database). NULL for migrated organizations.
    setup_completed_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    # The logo is a file in the logo storage; only its unpredictable key is kept here, and it is never sent to a browser.
    logo_storage_key: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    logo_content_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    logo_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class OrganizationInvitation(Base):
    """An emailed invitation for an organization's primary administrator.

    Only the SHA-256 hash of the token is stored; the plaintext token exists only in the email.
    """

    __tablename__ = "organization_invitations"
    __table_args__ = (
        # At most one pending (not accepted, not revoked) invitation per organization and email.
        # An organization can have several administrators, but never two live invitations for the same person.
        Index(
            "uq_organization_invitations_pending",
            "organization_id",
            "email",
            unique=True,
            postgresql_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()")
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    # Name given by the Super Admin when inviting (prefills the activation form); replaced by the name the
    # administrator confirms on activation. Optional: the primary-admin invitations carry no name.
    full_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set when a newer invitation replaces this one (resend). Revoked tokens can never be used.
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class OrganizationModule(Base):
    """One organization's entitlement to one business module (see app/modules.py). Never deleted: switching a module off keeps the row,
    and every business record stays where it is; switching it on again restores access to all of it."""

    __tablename__ = "organization_modules"

    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    module_key: Mapped[str] = mapped_column(String(30), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    # The Super Admin (Auth Service user id: users live in another database) who last changed it; NULL for the default and the migration.
    updated_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class OrganizationModuleHistory(Base):
    """Append-only record of every entitlement change: who, when, from what to what. A database trigger refuses UPDATE and DELETE."""

    __tablename__ = "organization_module_history"
    __table_args__ = (
        CheckConstraint("action IN ('seeded', 'migrated', 'enabled', 'disabled')", name="action_valid"),
        Index("ix_organization_module_history_organization_id_seq", "organization_id", "seq"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4, server_default=text("gen_random_uuid()"))
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), nullable=False)  # a strict order, even inside one transaction
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    module_key: Mapped[str] = mapped_column(String(30), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    old_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    new_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    changed_by: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    changed_by_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    changed_by_email: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    batch_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)  # the changes confirmed together
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
