# Sales orders, stock reservations and Delivered History (Step 23)

```
Create Order -> Reserve stock -> Delivery list (Ready) -> Edit / View / Remove -> Prepare dispatch -> Confirm dispatch
             -> deduct physical stock AND consume the reservation -> Invoice -> Payment
```

An organization administrator saves an order (a client and the products required). The stock is **reserved** at once, an order number
(`SO-000001`) and a linked delivery list (`DL-000001`, Ready, no manual step) are generated, and the order appears under **Delivery Lists**.
Physical stock changes only when a dispatch is **confirmed**. Orders never create invoices, payments or Finance entries.

## Stock figures (Inventory Service)

| | meaning |
|---|---|
| **On hand** (physical) | what is recorded in inventory |
| **Reserved** | committed to active sales orders, not yet dispatched |
| **Available** | on hand − reserved: what a new order, a manual stock-out or a scanner can still take |

500 on hand, an order for 400 → reserved 400, available 100. A second order can take at most 100 (asking for 150 is refused: *"Only 100 pcs of
Water bottle are available: 400 pcs are already reserved for other orders."*). Different orders may contain the same product; what is prevented is
booking the same units twice. Confirming a dispatch of 250 → on hand 250, reserved 150, available 100.

## Who owns what

* **Inventory Service** owns reservations: `stock_reservations` (one row per order line: `original = consumed + released + remaining`, unique per
  line, same-organization composite key to the product) and `stock_balances.reserved_quantity`. The database enforces `0 <= reserved <= on hand`,
  so **no operation** (manual stock-out, scanner, a plain dispatch, a bug) can take booked stock. Every booking check runs while the balance row is
  locked; balances are locked in product-id order (no deadlocks); an order is booked completely or not at all.
* **Sales Service** owns orders. `sales_orders` is the header; **an order's lines are the items of its delivery list** (one authoritative record: the
  order, its list and the dispatches can never disagree). Fulfilled quantity comes from confirmed dispatch lines.
* Reservation **writes** need the administrator's token *and* the shared secret `RESERVATION_API_KEY` (only the Sales Service has it), so a browser
  or any other client cannot book/release stock by inventing a sales order id. Reads need only the token.

## The cross-service workflow (no distributed transaction)

Every step that needs Inventory is durable and idempotent:

1. **Intent saved** in Sales (`pending_action` = create / edit / cancel / close, a stable `pending_key`, the complete desired lines). A new order is
   `pending_reservation` with a draft list: *never treated as booked*.
2. **Inventory asked** with no transaction open (`POST /reservations` with the totals, key `order-<id>-v<n>`; `/reservations/release`, key
   `release-<id>`). Inventory applies it in one transaction and stores its first answer; a retry replays it.
3. Only an answer that **matches** what was asked (this order; per line `consumed + remaining == ordered`) is applied: list → Ready, order → Active.
4. Timeout / crash / garbled answer: the intent stays. The next read of the order or the Delivery Lists page, a retried save (same Idempotency-Key),
   or `POST /orders/{id}/reconcile` asks again by key (`GET /reservations/by-key/{key}` first), so nothing is booked twice and nothing is stranded.
5. A definitive refusal fails the order (its draft list is cancelled); nothing is booked. Inventory unreachable before anything was created → 503 and
   nothing is created.

Lock order everywhere: delivery list, then order. Edits and cancels are refused while a dispatch is being posted; a dispatch is refused while a
change to the order is being applied.

## Sales API (`/api/v1/sales`)

| | |
|---|---|
| `POST /orders` | save an order (`Idempotency-Key` required). 201 created, 200 replay, 202 saved but booking not confirmed yet, 409 with the reason and shortages |
| `GET /orders?view=active\|delivered&q=` | active orders; delivered/closed orders completed in the last 24 hours (cutoff on the server's UTC clock) |
| `GET /orders/{id}` | lines (ordered / dispatched / remaining) with live on-hand, reserved, available stock; `can_edit`, `can_cancel`, reasons |
| `PATCH /orders/{id}` | complete desired lines + `version` (optimistic); releases the difference or books only the extra, all or nothing |
| `POST /orders/{id}/cancel` | nothing dispatched: list cancelled, reservation released, record kept; repeating is harmless |
| `POST /orders/{id}/cancel-remaining` | after a partial delivery: the undelivered remainder is cancelled (order *closed*); dispatched quantities untouched |
| `POST /orders/{id}/reconcile`, `GET /orders/{id}/delivery-list` | finish a half-done booking; the linked list |
| `POST /delivery-lists/{id}/book` | book an older list; marking a draft list Ready does the same |

Inventory API: `POST /reservations`, `POST /reservations/release` (secret required), `GET /reservations/by-key/{key}`,
`GET /reservations/source/{order id}`; `GET /stock`, `/stock/summary`, `/scan/resolve` now report `reserved_quantity` and `available_quantity`.
Dispatch posting lines may carry `order_line_id` (secret required): the stock is deducted and that line's reservation consumed in one transaction.

## One booking policy

A list becomes Ready only together with an atomic reservation of all its lines (Create Order, **Mark Ready** on a scanned/typed draft, **Book stock**).
The scanner and "New draft list" remain draft-entry tools: a draft reserves nothing and cannot be dispatched. Lists made before reservations existed:

* Ready, nothing dispatched → shown as *Not booked (older list)*; can be booked if the stock is available. Until then they may dispatch only
  **available** stock and can never eat booked stock.
* Partly dispatched → *Needs reconciliation*; never booked silently (what is still undelivered cannot be told from what was never booked).

## Generate Invoice (Delivery Lists card, after a dispatch)

Once an order is dispatched (the Dispatch confirmation was granted) its card changes: **View List** moves to the top, where Edit and Remove were (they are gone: a dispatched order can no longer be changed), and the one button at the bottom is **Generate Invoice**. It calls `POST /api/sales/orders/{id}/invoice` (portal) -> `POST /api/v1/sales/orders/{order_id}/invoice` (Sales Service, `app/order_invoice.py`) and then goes to the **Sales Invoice** page (`/invoices/sales?generated=<invoice id>`), which shows a banner and the new draft.

* The invoice is a **draft** (saved, no number yet): the client, and the CONFIRMED dispatch lines of the order's delivery list (product, SKU, name, unit and dispatched quantity are the dispatch's own, each line backed by its dispatch line). Discount and tax are zero; both can be set on the draft before it is issued. Issuing stays a deliberate step on the invoice.
* The unit price is the product's **current catalog selling price** (the same price the order's Cost shows), read from the Inventory Service with the caller's own token; the currency is the products'. A product without a price, or products in different currencies, make nothing and say why (no price is guessed, nothing is converted); the invoice can still be made by hand. This is the only place invoicing reads the catalog.
* It changes no stock and posts nothing to Finance. Repeating it (or six simultaneous clicks, serialized by a row lock on the order) never makes a second invoice: while a non-voided invoice already covers the order's dispatched goods, THAT invoice is returned (200, banner "already had an invoice"). Voiding it lets the order be invoiced again.
* Refused: an order nothing was dispatched from (409), another organization's order (404), an inactive client (409), an Inventory outage (503, nothing made).
* Verify: `python scripts/verify_generate_invoice.py` (31 checks), Sales tests `tests/test_order_invoice.py`, portal tests `orders-ui`, `order-invoice-api`, `invoice-ui`, `invoice-pages`.

## Delivered History

When the last line of an order is confirmed, the same transaction marks it **Delivered** and stamps `completed_at` (server UTC). `view=delivered`
lists orders with `completed_at` within the last 24 hours; afterwards the order simply stops matching the query - no job, no deletion, identical for
every administrator and reload. Dispatches, stock movements, reservations, invoices and payments are untouched. Active orders never expire.

## Database rules (Sales migration 0005, Inventory 0008 - both additive)

An order moves only pending_reservation → active → delivered / closed / cancelled (or → failed), must agree with its list (active ↔ Ready/Partially
Dispatched, delivered/closed ↔ Dispatched, cancelled/failed ↔ Cancelled), is never deleted, and a finished order never changes. The items guard keeps
every other list frozen; a list with an **active order** may change quantities (never below what was dispatched), gain products, and drop lines nothing
was dispatched from. Reservation rows are checked as above.

## Verify

```
python scripts/verify_sales_orders.py [--with-outage]     # live, against the running stack; deletes only what it created
```
