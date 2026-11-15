# Removal of Opening Balance and Opening Position

Impex no longer has an **Opening Balance** (stock) or an **Opening Position** (finance). Stock is entered with **Stock In**; Capital is established by an **investment** (an owner contribution).

## What was removed

| Where | Removed |
|---|---|
| Stock page | the **Opening Balance** button and its form; **Stock In** takes its place (the first quantity of a registered product, and every later one) |
| Add Stock form | "Opening quantity": the box is now **Quantity**, entered as a Stock In |
| Inventory Service | `POST /api/v1/inventory/stock/opening`, the "only before any other movement" rule, the `opening` operation kind in responses |
| Portal API | `POST /api/stock/opening`, `/api/finance/opening-positions` (list, create, reverse) |
| Finance page | the **Opening position** button and dialog, the "Set opening position" banner button |
| Finance Service | `GET\|POST /opening-positions`, `POST /opening-positions/{id}/reverse`, `capital.set_opening` / `reverse_opening`, the `has_opening_position` field of the summary |
| Wording | Capital's "Setup required" message now asks for an investment, never for an opening position |

## What was kept, on purpose (history)

Nothing recorded was changed, deleted or reset. **No database migration was needed or written**: removing the entry points does not change the schema, and the existing constraints must keep accepting the historical values.

* **Stock movements recorded as `opening`** stay in the append-only ledger exactly as they were (reason "Opening balance" included). They count in every balance, appear on the Movements page as **In**, and are found by the **In** filter.
* **Opening positions already recorded** (`opening_positions`, with their guards and audit lines) stay. An *active* one still counts as investment and as the start of Capital, so Capital, Investment and Profit & Loss figures built on it do not change. It is listed in the Finance history as read-only "Opening capital" (no Reverse button).
* The database check constraints (`stock_movements.movement_type`, `stock_operations.kind`, the finance audit `entity_type`) still allow `opening` so that those rows stay valid.
* The chart-of-accounts system account **3000 Opening Balance Equity** is an ordinary equity account that journal entries may already use; it is not part of the removed feature and was left alone.
* The word *opening* in the Finance reports' "opening / closing" figures means the start of the **period**, not an opening position.

## What changes for people

* First stock of a product: **Stock In** (or the Quantity box when adding the product, or a confirmed goods receipt).
* A new organization establishes Capital by recording an **investment**.
* Retrying a Stock In with the same key is applied once. Unlike the old opening balance, a Stock In with a *different* key is a new Stock In: if the answer to the first one may have been lost, check the Stock table before entering it again.

## Verification

Inventory Service tests, Finance Service tests, dashboard tests (`tests/no-opening-balance.test.ts` fails if the removed endpoints or wording come back) and the live checks `verify_add_stock.py`, `verify_stock_management.py`, `verify_capital_pnl.py`, `verify_trading_flow.py`.
