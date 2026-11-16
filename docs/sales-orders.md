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

## Client-specific prices (Sales migration 0006, Inventory 0010 - both additive)

Impex has **no universal selling price**: each client is charged what is negotiated for THEIR order. The price belongs to the order line, never to the product.

* **Create Order is two steps**: (1) *Select Client & Products* - client, order currency (starts from the organization's default currency, chosen from every currency), products with quantities (search or scan); the only buttons are **Cancel** and **Checkout**, and Checkout creates nothing and reserves nothing. (2) *Order Checkout* - the products, quantities, units and client are read-only; the ONLY editable fields are the **Per Piece Price** inputs; line totals and the order total follow exactly (decimal arithmetic, never floating point); **Save Order** stays off until EVERY product has a valid price (an empty price is never zero, an explicit 0 is a price; negative, malformed, more than 4 decimals or more than 14 whole digits are refused). **Back to Products** keeps everything. Only then does Save Order send the order.
* **Storage**: `sales_orders.currency_code` (the one currency of the order, never converted) and `delivery_list_items.unit_price` (the agreed price of ONE unit; the order lines ARE the delivery-list items, so there is one authoritative line record). NULL on both for orders made before prices were recorded: their negotiated prices are unknown and are not invented. Existing orders, lists, dispatches, invoices and payments are untouched.
* **API**: `POST /orders` requires `currency_code` and a `unit_price` on every line (422 otherwise); the idempotency fingerprint covers client, currency, every product, quantity and price (the same key with a different price is a 409, not a replay). `PATCH /orders/{id}`: lines keep their saved price unless one is sent, a NEW line must come with its price, a price cannot change once any of that line was dispatched (409 `price_locked`), prices cannot be added to a pre-price order (409 `prices_not_supported`).
* **Totals** (`total_amount`, `currency_code`, `prices_recorded` on orders; `unit_price`, `line_total` on lines) come from the order's own saved prices: the catalog and the Inventory Service are not consulted, so a catalog change never changes an order. A pre-price order shows "Price not recorded".
* **Stock**: a price has no influence on any stock figure; reservations, available and physical stock work exactly as before (the Inventory Service is never sent a price).
* **Invoices**: `GET /billable-lines` carries `agreed_unit_price`, `agreed_currency_code` and `order_number` per dispatched line; the Sales Invoice form starts in the order's currency (when all goods agree on one) and fills each line's price with the agreed one (still editable under the invoice's own rules, with a note when the typed price differs; never converted across currencies). Pre-price orders keep the explicit price entry.
* **Inventory**: `products.selling_price` is optional (column kept, values kept); the Stock table has no Price column (its Total is on hand x cost) and the product forms no longer ask for a selling price.

## Sales Invoice and Purchase Invoice (pages of the Sales and Purchasing modules)

There is no separate Invoices module and no "Generate Invoice" after a dispatch (that button, `POST /orders/{id}/invoice` and `scripts/verify_generate_invoice.py` are gone). Each of the two pages has two tabs at the top left: **New invoice** and **History**.

* **Sales Invoice has three tabs**: New invoice, **Pending payments**, History.
* **New invoice** lists the prepared orders (booked, waiting to be dispatched), newest first, with a client dropdown and an order-number search. **Create invoice** only OPENS the order (`/invoices/sales/create/<order id>`, read-only, nothing is saved by looking). There, **Print** and **Download** (bottom right) make the invoice of the whole order and print / save it (the same PDF template as every invoice, without due date or payment status). **Installments** (top right) asks for the number of installments (2 to 5) and how often (every N days / weeks / months); with both filled in, **Create invoice** (or Print / Download) makes the installment invoices. An order that already has its invoice shows **View invoice** instead; there is never a second set.
* **Installments**: the order's total is split into equal parts to the cent, the last one takes the leftover cents (500,000 in 5 = five invoices of 100,000; 100 in 3 = 33.33, 33.33, 33.34). Each installment is an invoice of its own with its own INV- number, the same lines, "Installment 2 of 5", the order total and the amount it asks for; the first is dated today and the others every N days / weeks / months after (a month-end date stays at the end of a shorter month). The first opens for printing; the others are **Pending payments** until their date arrives, then they appear in History by themselves (the date decides, nothing is changed). Pending payments is filtered by client and/or date, nearest first, and every row can be opened, printed or downloaded. Installments cannot be added to an invoice that already exists (it was frozen when it was made).
* **History** lists every past invoice, newest first, filtered by client and/or date, with **Print** and **Download** on every row (an order invoice and an older invoice each use their own PDF). Older invoices (made from dispatched goods, with payments) stay viewable there and keep their own page.
* **Purchase Invoice > New invoice** lists the purchase orders still waiting for goods and opens the existing receive-goods form; **History** lists the goods receipts, filtered by supplier and/or date. No new document.
* **Storage**: Sales migration `0007` adds `order_invoices` and `order_invoice_lines` (client and seller snapshots, append-only like the other ledgers); `0008` adds `installment_no` / `installment_count` (`subtotal` stays the whole order, `total` is what the invoice asks for, one invoice per order and installment number). Numbers continue the same INV- sequence. It changes no stock and posts nothing to Finance; the dashboard's "Invoiced this month" and the Finance feed still count only the older invoices.
* **API**: `POST /order-invoices` `{order_id, installments?: {count 2-5, every, unit days|weeks|months}}` (201 new, 200 existing, the FIRST invoice is returned; 409 `not_prepared` unless the order is booked and not yet dispatched; 422 `prices_not_recorded`, `too_small`), `GET /order-invoices/by-order`, `GET /order-invoices/{id}` (with the `schedule` of an installment plan), `GET /order-invoices/{id}/pdf`, `GET /invoice-history?client_id=&day=`, `GET /pending-payments?client_id=&day=`. `GET /orders?view=trade` lists every prepared, delivered or closed order, however old (used by the PNL calculator).
* Tests: Sales `tests/test_order_invoice.py`; portal `order-invoice-api`, `invoice-pages`, `sales-invoice-ui`, `installments`, `receipts-pages`, `receipts-ui`, `orders-ui`.

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
