"""add users.organization_id for organization administrators

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-03
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable: existing users (including the Super Admin) are untouched.
    op.add_column("users", sa.Column("organization_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_users_organization_id"), "users", ["organization_id"], unique=False)
    op.create_check_constraint(
        op.f("ck_users_org_admin_requires_org"),
        "users",
        "role <> 'organization-admin' OR organization_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_users_org_admin_requires_org"), "users", type_="check")
    op.drop_index(op.f("ix_users_organization_id"), table_name="users")
    op.drop_column("users", "organization_id")
