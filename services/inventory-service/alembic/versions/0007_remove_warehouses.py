"""remove warehouses: stock is kept per product only

DESTRUCTIVE and IRREVERSIBLE (it was requested explicitly: the business has a single location, so "warehouse" is removed everywhere). Take a
backup first (pg_dump of impex_inventory). What it does, in ONE transaction (it either completes or changes nothing):

  1. Stock transfers between warehouses are removed. A transfer is a pair of movements (out + in) that nets to zero for the product, so deleting
     the pairs changes no product total; their operations are deleted with them.
  2. The stock held in different warehouses is ADDED UP per product (exact decimals) into one balance per product.
  3. For the (few) products whose history spans several warehouses, `balance_after` is recomputed as the running TOTAL of the product, so it still
     means "the product's stock right after this movement". Products held in one warehouse only keep their movements exactly as they were.
  4. Before anything is dropped, the migration CHECKS that for every product the consolidated balance equals what the remaining ledger adds up to,
     and that no balance changed in total. If anything disagrees it raises and NOTHING is changed.
  5. warehouses, stock_balances.warehouse_id, stock_movements.warehouse_id and transfer_id (and their constraints and indexes) are dropped; the
     movement and operation kinds no longer include transfers.

Deleting ledger rows needs the out-of-band maintenance switch (SET LOCAL app.allow_ledger_maintenance = 'on'), which only lives for this transaction.
Rewriting `balance_after` is not covered by that switch (it only lets DELETE through), so the append-only trigger is switched OFF for the
renumbering step and back ON straight after it - inside the same transaction, so a failure anywhere restores everything, trigger included.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# per (organization, product): what the ledger adds up to (opening and in add, out subtracts; transfers net to zero and are gone)
LEDGER_TOTALS = """
SELECT organization_id, product_id,
       COALESCE(SUM(CASE WHEN movement_type IN ('opening', 'in') THEN quantity WHEN movement_type = 'out' THEN -quantity ELSE 0 END), 0) AS total
FROM stock_movements GROUP BY organization_id, product_id
"""


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("SELECT set_config('app.allow_ledger_maintenance', 'on', true)"))  # this transaction only

    # What every product holds right now, in total (the figure that must survive unchanged).
    before = {
        (str(o), str(p)): q
        for o, p, q in bind.execute(sa.text("SELECT organization_id, product_id, SUM(quantity) FROM stock_balances GROUP BY organization_id, product_id"))
    }

    # Products whose movements must be renumbered: held in several warehouses, or touched by a transfer.
    affected = bind.execute(sa.text(
        "SELECT DISTINCT organization_id, product_id FROM stock_movements WHERE movement_type IN ('transfer_in', 'transfer_out') "
        "UNION SELECT organization_id, product_id FROM stock_balances GROUP BY organization_id, product_id HAVING count(*) > 1"
    )).all()

    # 1. transfers
    bind.execute(sa.text("DELETE FROM stock_movements WHERE movement_type IN ('transfer_out', 'transfer_in')"))
    bind.execute(sa.text("DELETE FROM stock_operations WHERE kind = 'transfer'"))

    # 3. running product totals for the affected products (opening/in first within the same instant, then out; id only to make it deterministic)
    bind.execute(sa.text("ALTER TABLE stock_movements DISABLE TRIGGER trg_stock_movements_append_only"))  # re-enabled right after the loop
    for organization_id, product_id in affected:
        bind.execute(sa.text(
            """
            WITH ordered AS (
              SELECT id, SUM(CASE WHEN movement_type IN ('opening', 'in') THEN quantity ELSE -quantity END)
                         OVER (ORDER BY created_at, CASE movement_type WHEN 'opening' THEN 0 WHEN 'in' THEN 1 ELSE 2 END, id) AS running
              FROM stock_movements WHERE organization_id = :o AND product_id = :p
            )
            UPDATE stock_movements m SET balance_after = ordered.running FROM ordered WHERE m.id = ordered.id
            """
        ), {"o": organization_id, "p": product_id})
    bind.execute(sa.text("ALTER TABLE stock_movements ENABLE TRIGGER trg_stock_movements_append_only"))

    # 2. one balance per product: the first row keeps the total, the others go
    bind.execute(sa.text(
        """
        WITH totals AS (
          SELECT organization_id, product_id, SUM(quantity) AS total, (array_agg(id ORDER BY id))[1] AS keep_id
          FROM stock_balances GROUP BY organization_id, product_id
        )
        UPDATE stock_balances b SET quantity = t.total FROM totals t WHERE b.id = t.keep_id
        """
    ))
    bind.execute(sa.text(
        """
        DELETE FROM stock_balances b USING (
          SELECT (array_agg(id ORDER BY id))[1] AS keep_id, organization_id, product_id FROM stock_balances GROUP BY organization_id, product_id
        ) k WHERE b.organization_id = k.organization_id AND b.product_id = k.product_id AND b.id <> k.keep_id
        """
    ))

    # 4. the checks: nothing changed in total, and the balances agree with the ledger
    after = {(str(o), str(p)): q for o, p, q in bind.execute(sa.text("SELECT organization_id, product_id, quantity FROM stock_balances"))}
    if after != before:
        raise RuntimeError("Warehouse removal aborted: the consolidated stock does not equal the stock held before. Nothing was changed.")
    ledger = {(str(o), str(p)): q for o, p, q in bind.execute(sa.text(LEDGER_TOTALS))}
    for key, total in ledger.items():
        if after.get(key, 0) != total:
            raise RuntimeError(f"Warehouse removal aborted: the ledger of product {key[1]} adds up to {total} but its stock is {after.get(key, 0)}. Nothing was changed.")
    for organization_id, product_id in affected:  # the renumbered products: their last running balance must be the product's stock
        last = bind.execute(sa.text(
            "SELECT balance_after FROM stock_movements WHERE organization_id = :o AND product_id = :p "
            "ORDER BY created_at DESC, CASE movement_type WHEN 'out' THEN 0 WHEN 'in' THEN 1 ELSE 2 END, id LIMIT 1"
        ), {"o": organization_id, "p": product_id}).scalar()
        if last is not None and last != after.get((str(organization_id), str(product_id))):
            raise RuntimeError("Warehouse removal aborted: a recomputed running balance does not end at the product's stock. Nothing was changed.")

    # 5. the structure
    op.drop_constraint(op.f("ck_stock_movements_transfer_link_matches_type"), "stock_movements", type_="check")
    op.drop_constraint(op.f("ck_stock_movements_movement_type_valid"), "stock_movements", type_="check")
    op.create_check_constraint(op.f("ck_stock_movements_movement_type_valid"), "stock_movements", "movement_type IN ('opening', 'in', 'out')")
    op.drop_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", type_="check")
    op.create_check_constraint(op.f("ck_stock_operations_kind_valid"), "stock_operations", "kind IN ('opening', 'in', 'out', 'receipt', 'dispatch')")

    op.drop_index("ix_stock_movements_organization_id_warehouse_id_created_at", table_name="stock_movements")
    op.drop_constraint("fk_stock_movements_warehouse_same_organization", "stock_movements", type_="foreignkey")
    op.drop_column("stock_movements", "warehouse_id")
    op.drop_column("stock_movements", "transfer_id")

    op.drop_index("ix_stock_balances_organization_id_warehouse_id", table_name="stock_balances")
    op.drop_constraint("fk_stock_balances_warehouse_same_organization", "stock_balances", type_="foreignkey")
    op.drop_constraint("uq_stock_balances_organization_id_product_id_warehouse_id", "stock_balances", type_="unique")
    op.drop_column("stock_balances", "warehouse_id")
    op.create_unique_constraint("uq_stock_balances_organization_id_product_id", "stock_balances", ["organization_id", "product_id"])

    op.drop_table("warehouses")


def downgrade() -> None:
    raise RuntimeError(
        "Removing warehouses cannot be reversed: stock transfers and the split of stock between warehouses were deleted. "
        "Restore the pre-migration backup of impex_inventory instead."
    )
