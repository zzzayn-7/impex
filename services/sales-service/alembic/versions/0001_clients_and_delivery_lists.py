"""clients, delivery lists and delivery list items

A new database (impex_sales): nothing existing is touched. Delivery lists never move stock, so there is no stock table
here at all.

Revision ID: 0001
Revises:
Create Date: 2026-11-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TIMESTAMP = dict(type_=sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def _id():
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "clients",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("name_key", sa.String(length=255), nullable=False),
        sa.Column("contact_person", sa.String(length=255), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("phone", sa.String(length=50), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_clients")),
        sa.UniqueConstraint("organization_id", "name_key", name="uq_clients_organization_id_name_key"),
        sa.UniqueConstraint("organization_id", "id", name="uq_clients_organization_id_id"),
    )
    op.create_index(op.f("ix_clients_organization_id"), "clients", ["organization_id"], unique=False)

    op.create_table(
        "delivery_list_counters",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("last_number", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_delivery_list_counters")),
        sa.UniqueConstraint("organization_id", name="uq_delivery_list_counters_organization_id"),
    )
    op.create_index(op.f("ix_delivery_list_counters_organization_id"), "delivery_list_counters", ["organization_id"], unique=False)

    op.create_table(
        "delivery_lists",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("external_reference", sa.String(length=100), nullable=True),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=320), nullable=False),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("status IN ('draft', 'ready', 'cancelled')", name=op.f("ck_delivery_lists_status_valid")),
        sa.ForeignKeyConstraint(["organization_id", "client_id"], ["clients.organization_id", "clients.id"],
                                name="fk_delivery_lists_client_same_organization", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_delivery_lists")),
        sa.UniqueConstraint("organization_id", "number", name="uq_delivery_lists_organization_id_number"),
        sa.UniqueConstraint("organization_id", "id", name="uq_delivery_lists_organization_id_id"),
    )
    op.create_index(op.f("ix_delivery_lists_organization_id"), "delivery_lists", ["organization_id"], unique=False)
    op.create_index("ix_delivery_lists_organization_id_client_id", "delivery_lists", ["organization_id", "client_id"], unique=False)
    op.create_index("ix_delivery_lists_organization_id_status", "delivery_lists", ["organization_id", "status"], unique=False)

    op.create_table(
        "delivery_list_items",
        _id(),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_list_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("product_sku", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=255), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column("unit", sa.String(length=20), nullable=False),
        sa.Column("planned_warehouse_id", sa.Uuid(), nullable=True),
        sa.Column("planned_warehouse_code", sa.String(length=32), nullable=True),
        sa.Column("created_at", **TIMESTAMP),
        sa.Column("updated_at", **TIMESTAMP),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_delivery_list_items_quantity_positive")),
        sa.ForeignKeyConstraint(["organization_id", "delivery_list_id"], ["delivery_lists.organization_id", "delivery_lists.id"],
                                name="fk_delivery_list_items_delivery_list_same_organization", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_delivery_list_items")),
        sa.UniqueConstraint("organization_id", "delivery_list_id", "product_id",
                            name="uq_delivery_list_items_list_product"),
    )
    op.create_index(op.f("ix_delivery_list_items_organization_id"), "delivery_list_items", ["organization_id"], unique=False)
    op.create_index("ix_delivery_list_items_organization_id_delivery_list_id", "delivery_list_items", ["organization_id", "delivery_list_id"], unique=False)


def downgrade() -> None:
    op.drop_table("delivery_list_items")
    op.drop_table("delivery_lists")
    op.drop_table("delivery_list_counters")
    op.drop_table("clients")
