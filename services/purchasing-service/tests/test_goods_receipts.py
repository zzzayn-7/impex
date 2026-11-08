"""Goods receiving: drafts, partial receipts, the durable confirm workflow, over-receipt, failures between the two services."""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import ORDERS, RECEIPTS, received


def d(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture
def order(api, shop):
    """PO-000001: 10 bolts (pieces) and 5 kg of flour, placed."""
    return api.ordered(shop)


@pytest.fixture
def bolt_line(order, shop):
    return lambda accepted, **kw: received(order, shop["bolt"], accepted, **kw)


@pytest.fixture
def flour_line(order, shop):
    return lambda accepted, **kw: received(order, shop["flour"], accepted, **kw)


def stock(inventory, shop, product) -> Decimal:
    return inventory.quantity(shop[product])


# =====================================================================================================
# Receiving in full
# =====================================================================================================
def test_a_full_receipt_adds_the_goods_and_completes_the_order(api, shop, inventory, order, bolt_line, flour_line):
    before = stock(inventory, shop, "bolt")
    draft = api.draft(order["id"], [bolt_line(10), flour_line(5)], supplier_reference="DN-1042", notes="Pallet 3")
    assert draft["number"] == "GR-000001" and draft["status"] == "draft" and draft["editable"] is True
    assert draft["supplier_reference"] == "DN-1042" and draft["purchase_order"]["number"] == "PO-000001"
    assert stock(inventory, shop, "bolt") == before and inventory.postings() == []  # a draft changes no stock

    response = api.confirm(draft["id"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "confirmed" and body["confirmed_by_email"] == "admin-alpha@example.org" and body["inventory_operation_id"]
    assert all(l["inventory_movement_id"] for l in body["lines"]) and body["editable"] is False
    assert stock(inventory, shop, "bolt") == before + 10 and stock(inventory, shop, "flour") == d("2.5") + 5

    detail = api.detail(order["id"])
    assert detail["status"] == "received" and detail["can_receive"] is False
    assert [(l["received_quantity"], l["pending_quantity"], l["remaining_quantity"]) for l in detail["lines"]] == [("10.0000", "0.0000", "0.0000"), ("5.0000", "0.0000", "0.0000")]
    assert [(r["number"], r["status"]) for r in detail["receipts"]] == [("GR-000001", "confirmed")]


def test_the_inventory_service_is_asked_once_with_a_key_made_from_the_receipt_id(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(4)])
    api.confirm(draft["id"])
    (posting,) = inventory.postings()
    assert posting[2] == "admin-alpha"  # the caller's own token, never a service credential
    (key,) = [k for (_, k) in inventory.operations]
    assert key == f"goods-receipt-{draft['id']}"


def test_the_posting_carries_only_accepted_quantities_and_never_a_price(api, shop, inventory, order, bolt_line, flour_line, monkeypatch):
    seen = []
    original = inventory._post_receipt

    def spy(org, request):
        import json
        seen.append(json.loads(request.content))
        return original(org, request)

    monkeypatch.setattr(inventory, "_post_receipt", spy)
    draft = api.draft(order["id"], [bolt_line(4, rejected=2), flour_line(0, rejected=1)])
    api.confirm(draft["id"])
    (body,) = seen
    assert set(body) == {"receipt_number", "purchase_order_number", "lines"}
    assert [(l["quantity"], l["unit"]) for l in body["lines"]] == [("4.0000", "pcs")]  # the flour line accepted nothing: not sent at all
    assert all(set(l) == {"line_id", "product_id", "quantity", "unit"} for l in body["lines"])  # no warehouse, no price


# =====================================================================================================
# Partial receiving
# =====================================================================================================
def test_partial_receipts_accumulate_until_the_order_is_complete(api, shop, inventory, order, bolt_line, flour_line):
    first = api.draft(order["id"], [bolt_line(3), flour_line(5)])
    assert api.confirm(first["id"]).status_code == 200
    detail = api.detail(order["id"])
    assert detail["status"] == "partially_received" and detail["can_receive"] is True
    bolts = next(l for l in detail["lines"] if l["product_id"] == shop["bolt"])
    assert (bolts["quantity"], bolts["received_quantity"], bolts["remaining_quantity"]) == ("10.0000", "3.0000", "7.0000")

    second = api.draft(order["id"], [bolt_line(7)])
    (line,) = second["lines"]
    assert (line["ordered_quantity"], line["received_elsewhere_quantity"], line["receivable_quantity"]) == ("10.0000", "3.0000", "7.0000")
    assert api.confirm(second["id"]).status_code == 200
    assert api.detail(order["id"])["status"] == "received"
    assert stock(inventory, shop, "bolt") == 40 + 10
    assert [r["number"] for r in api.detail(order["id"])["receipts"]] == ["GR-000002", "GR-000001"]  # newest first


def test_a_thirty_and_twenty_split_of_fifty(api, shop, inventory):
    big = api.ordered(shop, lines=(("bolt", 50),), supplier="Big")
    first = api.draft(big["id"], [received(big, shop["bolt"], 30)])
    api.confirm(first["id"])
    mid = api.detail(big["id"])
    assert mid["status"] == "partially_received" and mid["lines"][0]["remaining_quantity"] == "20.0000"
    second = api.draft(big["id"], [received(big, shop["bolt"], 20)])
    api.confirm(second["id"])
    assert api.detail(big["id"])["status"] == "received"
    assert stock(inventory, shop, "bolt") == 40 + 50


def test_two_receipts_for_one_order_add_up_in_one_stock_figure(api, shop, inventory, order, bolt_line, flour_line):
    first = api.draft(order["id"], [bolt_line(6), flour_line(5)])
    second = api.draft(order["id"], [bolt_line(4)])
    api.confirm(first["id"])
    api.confirm(second["id"])
    assert stock(inventory, shop, "bolt") == 50 and stock(inventory, shop, "flour") == d("7.5")
    assert api.detail(order["id"])["status"] == "received"


def test_every_accepted_line_makes_a_traceable_movement(api, shop, inventory, order, bolt_line, flour_line):
    draft = api.draft(order["id"], [bolt_line(10), flour_line(2)])
    confirmed = api.confirm(draft["id"]).json()
    assert len(inventory.ledger) == 2
    by_product = {m["product_id"]: m for m in inventory.ledger}
    assert by_product[shop["bolt"]]["source_reference"] == "GR-000001"
    assert by_product[shop["bolt"]]["balance_after"] == "50.0000" and by_product[shop["flour"]]["balance_after"] == "4.5000"
    assert {l["inventory_movement_id"] for l in confirmed["lines"]} == {m["id"] for m in inventory.ledger}


# =====================================================================================================
# No over-receipt
# =====================================================================================================
def test_more_than_ordered_is_refused_when_saving(api, order, bolt_line, flour_line):
    response = api.receipt(order["id"], [flour_line("5.0001")])
    assert response.status_code == 409 and "at most 5 can still be received" in response.json()["detail"]["message"]
    assert api.receipt(order["id"], [bolt_line(11)]).status_code == 409
    assert api.receipt(order["id"], [flour_line("5.0000")]).status_code == 201
    assert response.json()["detail"]["code"] == "over_receipt"


def test_more_than_remains_is_refused_after_a_partial_receipt(api, shop, order, bolt_line):
    api.confirm(api.draft(order["id"], [bolt_line(8)])["id"])
    response = api.receipt(order["id"], [bolt_line(3)])
    assert response.status_code == 409 and "already received 8" in response.json()["detail"]["message"]
    assert api.receipt(order["id"], [bolt_line(2)]).status_code == 201


def test_two_drafts_may_each_ask_for_the_whole_remainder_but_only_one_can_be_confirmed(api, shop, inventory, order, bolt_line):
    one, two = api.draft(order["id"], [bolt_line(10)]), api.draft(order["id"], [bolt_line(10)])  # drafts reserve nothing
    assert api.confirm(one["id"]).status_code == 200
    refused = api.confirm(two["id"])
    assert refused.status_code == 409 and "at most 0 can still be received" in refused.json()["detail"]["message"]
    assert api.get_receipt(two["id"])["status"] == "draft"  # untouched: it can be edited down or cancelled
    assert stock(inventory, shop, "bolt") == 50


def test_concurrent_confirmations_can_never_over_receive(api, shop, inventory, order, bolt_line, client):
    drafts = [api.draft(order["id"], [bolt_line(6)]) for _ in range(4)]
    results, refusals = [], []

    def go(receipt):
        response = client.post(f"{RECEIPTS}/{receipt['id']}/confirm", headers=api.headers)
        results.append(response.status_code)
        if response.status_code == 409:
            refusals.append(response.json()["detail"])

    threads = [threading.Thread(target=go, args=(r,)) for r in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200, 409, 409, 409]  # 6 of 10 fits once; nothing else fits
    # the losers are told why in plain words (the order is locked while they are judged), not by a database error
    assert all(isinstance(r, dict) and r["code"] == "over_receipt" for r in refusals), refusals
    assert stock(inventory, shop, "bolt") == 46 and len(inventory.ledger) == 1
    assert api.detail(order["id"])["status"] == "partially_received"


def test_concurrent_confirmations_of_receipts_that_fit_together_all_succeed(api, shop, inventory, order, bolt_line, client):
    drafts = [api.draft(order["id"], [bolt_line(2)]) for _ in range(5)]
    results = []

    def go(receipt):
        results.append(client.post(f"{RECEIPTS}/{receipt['id']}/confirm", headers=api.headers).status_code)

    threads = [threading.Thread(target=go, args=(r,)) for r in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert results == [200] * 5 and stock(inventory, shop, "bolt") == 50
    assert api.detail(order["id"])["lines"][0]["remaining_quantity"] == "0.0000"


def test_confirming_the_same_receipt_many_times_at_once_adds_the_goods_once(api, shop, inventory, order, bolt_line, client):
    draft = api.draft(order["id"], [bolt_line(10)])
    results = []

    def go():
        results.append(client.post(f"{RECEIPTS}/{draft['id']}/confirm", headers=api.headers).status_code)

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert set(results) <= {200, 202} and 200 in results
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1
    assert api.get_receipt(draft["id"])["status"] == "confirmed"


# =====================================================================================================
# Idempotent confirmation
# =====================================================================================================
def test_confirming_twice_changes_nothing_the_second_time(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    first, second = api.confirm(draft["id"]), api.confirm(draft["id"])
    assert (first.status_code, second.status_code) == (200, 200)
    assert second.json()["confirmed_at"] == first.json()["confirmed_at"] and second.json()["inventory_operation_id"] == first.json()["inventory_operation_id"]
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.postings()) == 1 and len(inventory.ledger) == 1


# =====================================================================================================
# Failures between the two services
# =====================================================================================================
def test_when_the_answer_is_lost_after_inventory_committed_a_retry_finishes_without_adding_twice(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_after"]
    inventory.lookup_mode = "500"  # and the status check cannot reach it either
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202
    body = pending.json()
    assert body["status"] == "posting" and body["posting"]["attempts"] == 1 and "did not answer" in body["posting"]["last_error"]
    assert stock(inventory, shop, "bolt") == 50  # Inventory DID add it...
    assert api.detail(order["id"])["status"] == "ordered"  # ...but Purchasing does not claim it is received until it has verified that
    assert api.detail(order["id"])["lines"][0]["pending_quantity"] == "10.0000"  # the quantity stays reserved meanwhile

    inventory.lookup_mode = None
    done = api.confirm(draft["id"])
    assert done.status_code == 200 and done.json()["status"] == "confirmed" and done.json()["posting"]["attempts"] == 2
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1  # added exactly once
    assert {key for (_, key) in inventory.operations} == {f"goods-receipt-{draft['id']}"}  # the same key both times
    assert api.detail(order["id"])["status"] == "partially_received"


def test_a_lost_answer_is_recovered_by_asking_inventory_what_happened(api, shop, inventory, order, bolt_line):
    """When the by-key status check works, confirm completes in the SAME request: no retry needed."""
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_after"]
    done = api.confirm(draft["id"])
    assert done.status_code == 200 and done.json()["status"] == "confirmed"
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1


def test_a_500_after_inventory_committed_is_recovered_too(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["500_after"]
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1


def test_when_inventory_never_received_the_request_nothing_is_added_and_a_retry_posts_it(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_before"]
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202 and pending.json()["status"] == "posting"
    assert stock(inventory, shop, "bolt") == 40 and inventory.ledger == []
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1


def test_inventory_failing_before_doing_anything_leaves_a_retryable_posting(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["500_before"]
    assert api.confirm(draft["id"]).status_code == 202
    receipt = api.get_receipt(draft["id"])
    assert receipt["status"] == "posting" and "failed (500)" in receipt["posting"]["last_error"]
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, shop, "bolt") == 50


def test_a_posting_receipt_cannot_be_edited_cancelled_or_taken_by_another_receipt(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    other = api.draft(order["id"], [bolt_line(1)])  # a draft reserves nothing, so this one can be prepared
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    assert api.put_lines(draft["id"], [bolt_line(1)]).status_code == 409
    assert api.client.patch(f"{RECEIPTS}/{draft['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    cancelled = api.cancel_receipt(draft["id"])
    assert cancelled.status_code == 409 and "being added to stock" in cancelled.json()["detail"]
    refused = api.confirm(other["id"])  # but the posting has reserved all 10, so this cannot be confirmed meanwhile
    assert api.receipt(order["id"], [bolt_line(1)]).status_code == 409  # nor can a new one be prepared against the reserved goods
    assert refused.status_code == 409 and "being posted" in refused.json()["detail"]["message"]


def test_an_answer_that_does_not_match_the_receipt_is_not_trusted(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["wrong_answer"]
    inventory.lookup_mode = "500"
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202 and "did not match" in pending.json()["posting"]["last_error"]
    assert api.get_receipt(draft["id"])["status"] == "posting"
    inventory.lookup_mode = None
    assert api.confirm(draft["id"]).status_code == 200  # the replayed (correct) answer verifies


def test_a_crash_after_inventory_committed_but_before_purchasing_recorded_it_is_recoverable(api, shop, inventory, order, bolt_line, monkeypatch):
    from app import receipts

    draft = api.draft(order["id"], [bolt_line(10)])

    def crash(*args, **kwargs):
        raise RuntimeError("the process was killed")

    monkeypatch.setattr(receipts, "_finish", crash)
    with pytest.raises(RuntimeError):
        api.confirm(draft["id"])
    monkeypatch.undo()
    assert stock(inventory, shop, "bolt") == 50  # inventory has it
    assert api.get_receipt(draft["id"])["status"] == "posting"  # purchasing has the saved intent
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, shop, "bolt") == 50 and len(inventory.ledger) == 1


def test_a_crash_right_after_the_intent_was_saved_is_recoverable(api, shop, inventory, order, bolt_line, monkeypatch):
    draft = api.draft(order["id"], [bolt_line(10)])
    from app.inventory import InventoryGateway

    def crash(self, key, body):
        raise RuntimeError("the process was killed before anything was sent")

    monkeypatch.setattr(InventoryGateway, "post_goods_receipt", crash)
    with pytest.raises(RuntimeError):
        api.confirm(draft["id"])
    monkeypatch.undo()
    assert stock(inventory, shop, "bolt") == 40 and api.get_receipt(draft["id"])["status"] == "posting"
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, shop, "bolt") == 50


def test_a_definitive_refusal_returns_the_receipt_to_draft_and_adds_nothing(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["reject"]
    refused = api.confirm(draft["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "inventory_rejected" and "archived" in refused.json()["detail"]["message"]
    receipt = api.get_receipt(draft["id"])
    assert receipt["status"] == "draft" and receipt["editable"] is True and "archived" in receipt["posting"]["last_error"]
    assert stock(inventory, shop, "bolt") == 40 and api.detail(order["id"])["lines"][0]["pending_quantity"] == "0.0000"  # reservation released
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, shop, "bolt") == 50


def test_inventory_down_at_confirmation_explains_and_changes_nothing(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.mode = "down"
    response = api.confirm(draft["id"])
    assert response.status_code == 503 and "inventory service is unavailable" in response.json()["detail"]
    inventory.mode = None
    assert api.get_receipt(draft["id"])["status"] == "draft" and inventory.ledger == []
    assert api.confirm(draft["id"]).status_code == 200


def test_inventory_going_down_between_checking_and_posting_leaves_a_posting_receipt(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_before"]
    inventory.lookup_mode = "500"
    assert api.confirm(draft["id"]).status_code == 202
    assert stock(inventory, shop, "bolt") == 40 and inventory.ledger == []
    inventory.lookup_mode = None
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, shop, "bolt") == 50


def test_an_expired_token_at_posting_time_keeps_the_receipt_posting(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    inventory.mode = "401"
    assert api.confirm(draft["id"]).status_code == 401
    inventory.mode = None
    assert api.get_receipt(draft["id"])["status"] == "posting"
    assert api.confirm(draft["id"]).status_code == 200


def test_a_receipt_is_never_confirmed_on_hope(api, shop, inventory, order, bolt_line):
    """Whatever goes wrong, `confirmed` implies a verified posting: an operation id and a movement on every accepted line."""
    draft = api.draft(order["id"], [bolt_line(10)])
    for mode in ("timeout_before", "500_before", "wrong_answer", "500_before"):
        inventory.post_modes = [mode]
        inventory.lookup_mode = "500"
        assert api.confirm(draft["id"]).status_code == 202
        receipt = api.get_receipt(draft["id"])
        assert receipt["status"] == "posting" and receipt["confirmed_at"] is None and receipt["inventory_operation_id"] is None
        assert all(l["inventory_movement_id"] is None for l in receipt["lines"])
    assert api.get_receipt(draft["id"])["posting"]["attempts"] == 4


# =====================================================================================================
# Validation
# =====================================================================================================
@pytest.mark.parametrize("accepted, rejected, detail", [("2.5", "0", "whole number"), ("1", "0.5", "whole number")])
def test_whole_units_need_whole_quantities(api, order, bolt_line, accepted, rejected, detail):
    response = api.receipt(order["id"], [bolt_line(accepted, rejected=rejected)])
    assert response.status_code == 422 and detail in response.json()["detail"]


def test_measurable_units_accept_fractions(api, shop, inventory, order, flour_line):
    draft = api.draft(order["id"], [flour_line("2.25")])
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, shop, "flour") == d("4.75")


@pytest.mark.parametrize("accepted", ["-1", "abc", "1.00001", "100000000000000000", None])
def test_bad_quantities_are_refused(api, order, bolt_line, accepted):
    line = bolt_line(1)
    line["accepted_quantity"] = accepted
    assert api.receipt(order["id"], [line]).status_code == 422


def test_a_line_that_names_a_warehouse_is_refused(api, order, bolt_line):
    response = api.receipt(order["id"], [bolt_line(2, warehouse_id=str(uuid.uuid4()))])
    assert response.status_code == 422  # there is no warehouse to name any more


def test_archived_products_are_refused(api, shop, inventory, order, bolt_line):
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = False
    product = api.receipt(order["id"], [bolt_line(1)])
    assert product.status_code == 409 and "Steel bolt is archived" in product.json()["detail"]
    rejected_only = api.receipt(order["id"], [bolt_line(0, rejected=1)])  # nothing goes to stock: allowed to note it
    assert rejected_only.status_code == 201


def test_a_product_archived_after_the_draft_was_saved_is_caught_at_confirmation_before_anything_is_reserved(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.products[shop["org"]][shop["bolt"]]["is_active"] = False
    response = api.confirm(draft["id"])
    assert response.status_code == 409 and "archived" in response.json()["detail"]
    assert api.get_receipt(draft["id"])["status"] == "draft" and inventory.postings() == []


def test_a_unit_changed_since_ordering_is_refused_and_never_converted(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.products[shop["org"]][shop["bolt"]]["unit"] = "box"
    response = api.confirm(draft["id"])
    assert response.status_code == 409 and "never converted" in response.json()["detail"]
    assert stock(inventory, shop, "bolt") == 40 and inventory.postings() == []
    assert api.receipt(order["id"], [bolt_line(1)]).status_code == 409  # and a new draft is refused too


def test_a_product_that_is_not_on_the_order_is_refused(api, shop, order, bolt_line):
    other = api.ordered(shop, lines=(("bolt", 3),), supplier="Other")
    foreign = received(other, shop["bolt"], 1)  # the line id of ANOTHER order
    response = api.receipt(order["id"], [foreign])
    assert response.status_code == 404 and response.json()["detail"] == "That product is not on this purchase order."
    assert api.receipt(order["id"], [{**bolt_line(1), "purchase_order_line_id": str(uuid.uuid4())}]).json()["detail"] == response.json()["detail"]


def test_a_line_may_appear_once(api, order, bolt_line):
    response = api.receipt(order["id"], [bolt_line(1), bolt_line(2)])
    assert response.status_code == 422 and "more than once" in response.json()["detail"]


def test_unknown_and_forbidden_fields_are_refused(api, order, bolt_line):
    for extra in ({"organization_id": str(uuid.uuid4())}, {"status": "confirmed"}, {"number": "GR-999"}, {"posting_key": "x"}):
        assert api.receipt(order["id"], [], **extra).status_code == 422
    for field in ("product_id", "unit", "unit_price", "product_name", "inventory_movement_id"):
        assert api.receipt(order["id"], [{**bolt_line(1), field: "x"}]).status_code == 422, field


def test_the_receiving_date_cannot_be_in_the_future(api, order):
    assert api.receipt(order["id"], [], received_date="2999-01-01").status_code == 422
    assert api.receipt(order["id"], [], received_date="2026-11-01").status_code == 201


# =====================================================================================================
# Rejected quantities
# =====================================================================================================
def test_a_rejected_quantity_is_recorded_but_never_becomes_stock(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(7, rejected=3)])
    confirmed = api.confirm(draft["id"]).json()
    (line,) = confirmed["lines"]
    assert (line["accepted_quantity"], line["rejected_quantity"]) == ("7.0000", "3.0000")
    assert stock(inventory, shop, "bolt") == 47 and inventory.ledger[0]["quantity"] == "7.0000"
    assert api.detail(order["id"])["lines"][0]["received_quantity"] == "7.0000"  # the rejected 3 are not "received"


def test_a_receipt_that_accepts_nothing_cannot_be_confirmed(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(0, rejected=4)])
    response = api.confirm(draft["id"])
    assert response.status_code == 422 and "Nothing is accepted" in response.json()["detail"]
    empty = api.draft(order["id"], [])
    assert api.confirm(empty["id"]).status_code == 422
    assert inventory.postings() == [] and api.get_receipt(draft["id"])["status"] == "draft"


# =====================================================================================================
# Status rules
# =====================================================================================================
def test_goods_are_received_only_against_ordered_or_partially_received_orders(api, shop, order, bolt_line):
    draft_order = api.order(api.supplier("Fresh")["id"])
    api.add(draft_order["id"], shop["bolt"], 3, "1")
    response = api.receipt(draft_order["id"], [])
    assert response.status_code == 409 and "still a draft" in response.json()["detail"]

    cancelled = api.ordered(shop, lines=(("bolt", 2),), supplier="Gone")
    api.action(cancelled["id"], "cancel")
    assert "cancelled" in api.receipt(cancelled["id"], []).json()["detail"]

    done = api.ordered(shop, lines=(("bolt", 2),), supplier="Done")
    api.confirm(api.draft(done["id"], [received(done, shop["bolt"], 2)])["id"])
    assert "already fully received" in api.receipt(done["id"], []).json()["detail"]


def test_a_confirmed_receipt_is_permanent(api, shop, order, bolt_line):
    confirmed = api.confirm(api.draft(order["id"], [bolt_line(4)])["id"]).json()
    assert api.put_lines(confirmed["id"], [bolt_line(1)]).status_code == 409
    assert api.client.patch(f"{RECEIPTS}/{confirmed['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    cancelled = api.cancel_receipt(confirmed["id"])
    assert cancelled.status_code == 409 and "cannot be cancelled" in cancelled.json()["detail"]
    assert api.client.delete(f"{RECEIPTS}/{confirmed['id']}", headers=api.headers).status_code == 405
    assert api.get_receipt(confirmed["id"])["lines"][0]["accepted_quantity"] == "4.0000"


def test_a_draft_can_be_edited_and_cancelled_and_a_cancelled_one_stays(api, shop, inventory, order, bolt_line, flour_line):
    draft = api.draft(order["id"], [bolt_line(2)], notes="first")
    edited = api.client.patch(f"{RECEIPTS}/{draft['id']}", json={"notes": "second", "supplier_reference": "DN-2"}, headers=api.headers).json()
    assert (edited["notes"], edited["supplier_reference"]) == ("second", "DN-2")
    replaced = api.put_lines(draft["id"], [flour_line(1)]).json()
    assert [l["product_name"] for l in replaced["lines"]] == ["Flour"]
    cancelled = api.cancel_receipt(draft["id"])
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled" and cancelled.json()["cancelled_by_email"]
    assert api.cancel_receipt(draft["id"]).status_code == 200  # repeating is harmless
    assert api.confirm(draft["id"]).status_code == 409
    assert api.put_lines(draft["id"], []).status_code == 409
    assert api.get_receipt(draft["id"])["status"] == "cancelled" and inventory.postings() == []


def test_cancelling_a_receipt_frees_nothing_because_a_draft_reserves_nothing(api, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(10)])
    api.cancel_receipt(draft["id"])
    assert api.detail(order["id"])["lines"][0]["remaining_quantity"] == "10.0000"


def test_cancelling_an_order_cancels_its_draft_receipts_but_never_hides_received_goods(api, shop, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(2)])
    assert api.action(order["id"], "cancel").status_code == 200
    assert api.get_receipt(draft["id"])["status"] == "cancelled"

    received_order = api.ordered(shop, lines=(("bolt", 5),), supplier="Half")
    api.confirm(api.draft(received_order["id"], [received(received_order, shop["bolt"], 2)])["id"])
    blocked = api.action(received_order["id"], "cancel")
    assert blocked.status_code == 409 and "already has goods received" in blocked.json()["detail"]
    assert api.detail(received_order["id"])["status"] == "partially_received"


def test_cancelling_an_order_with_a_posting_receipt_is_refused(api, shop, inventory, order, bolt_line):
    draft = api.draft(order["id"], [bolt_line(2)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    blocked = api.action(order["id"], "cancel")
    assert blocked.status_code == 409 and "cannot be cancelled" in blocked.json()["detail"]


def test_received_orders_stay_frozen(api, shop, order, bolt_line, flour_line):
    api.confirm(api.draft(order["id"], [bolt_line(10), flour_line(5)])["id"])
    line = api.detail(order["id"])["lines"][0]
    assert api.client.patch(f"{ORDERS}/{order['id']}/lines/{line['id']}", json={"quantity": "99"}, headers=api.headers).status_code == 409
    assert api.client.patch(f"{ORDERS}/{order['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    assert api.add(order["id"], shop["old"], 1, 1).status_code == 409


# =====================================================================================================
# Nothing but a confirmed receipt touches inventory
# =====================================================================================================
def test_drafting_editing_cancelling_and_ordering_never_post_to_inventory(api, shop, inventory, order, bolt_line, flour_line):
    snapshot = inventory.snapshot()
    draft = api.draft(order["id"], [bolt_line(3)])
    api.put_lines(draft["id"], [bolt_line(4), flour_line(1)])
    api.client.patch(f"{RECEIPTS}/{draft['id']}", json={"notes": "n"}, headers=api.headers)
    api.get_receipt(draft["id"])
    api.cancel_receipt(draft["id"])
    api.client.get(RECEIPTS, headers=api.headers)
    assert inventory.writes() == [] and inventory.snapshot() == snapshot and inventory.ledger == []


def test_the_only_write_ever_made_is_the_posting_of_a_confirmed_receipt(api, shop, inventory, order, bolt_line):
    api.confirm(api.draft(order["id"], [bolt_line(3)])["id"])
    assert [(m, p) for m, p, _ in inventory.writes()] == [("POST", "/api/v1/inventory/goods-receipts")]


def test_prices_history_and_other_stock_are_untouched(api, shop, inventory, order, bolt_line):
    product = inventory.products[shop["org"]][shop["bolt"]]
    before = (product["selling_price"], product["cost_price"], inventory.snapshot()[shop["flour"]])
    order_before = api.detail(order["id"])
    api.confirm(api.draft(order["id"], [bolt_line(10)])["id"])
    assert (product["selling_price"], product["cost_price"], inventory.snapshot()[shop["flour"]]) == before
    after = api.detail(order["id"])
    assert [(l["unit_price"], l["line_total"], l["quantity"], l["product_name"]) for l in after["lines"]] == [
        (l["unit_price"], l["line_total"], l["quantity"], l["product_name"]) for l in order_before["lines"]
    ]
    assert after["total_amount"] == order_before["total_amount"] == "30.0000"  # 10 x 2.00 + 5 x 2.00: receiving never reprices the order


def test_existing_orders_keep_their_status_and_lines(api, shop, order):
    """Orders placed before receiving existed are ordinary Ordered orders: nothing about them changes."""
    detail = api.detail(order["id"])
    assert detail["status"] == "ordered" and detail["can_receive"] is True and detail["receipts"] == []
    assert [(l["received_quantity"], l["pending_quantity"], l["remaining_quantity"]) for l in detail["lines"]] == [("0.0000", "0.0000", "10.0000"), ("0.0000", "0.0000", "5.0000")]


# =====================================================================================================
# Numbers, idempotent creation
# =====================================================================================================
def test_numbers_run_per_organization(api, two_orgs, inventory, order, bolt_line):
    assert [api.draft(order["id"], [bolt_line(1)])["number"] for _ in range(3)] == ["GR-000001", "GR-000002", "GR-000003"]
    beta = two_orgs["beta"]
    product = inventory.add_product(two_orgs["beta_id"], "B-1", "Beta thing")
    placed = beta.ordered({"thing": product}, lines=(("thing", 4),))
    assert beta.draft(placed["id"], [received(placed, product, 1)])["number"] == "GR-000001"


def test_a_repeated_creation_returns_the_same_draft(api, order, bolt_line):
    first = api.receipt(order["id"], [bolt_line(2)], key="receipt-key-0001")
    again = api.receipt(order["id"], [bolt_line(2)], key="receipt-key-0001")
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["id"] == again.json()["id"]
    different = api.receipt(order["id"], [bolt_line(3)], key="receipt-key-0001")
    assert different.status_code == 409 and "different request" in different.json()["detail"]
    assert len(api.client.get(RECEIPTS, headers=api.headers).json()["items"]) == 1


def test_a_failed_creation_does_not_burn_its_key_or_a_number(api, order, bolt_line):
    assert api.receipt(order["id"], [bolt_line(11)], key="receipt-key-0002").status_code == 409
    ok = api.receipt(order["id"], [bolt_line(1)], key="receipt-key-0002")
    assert ok.status_code == 201 and ok.json()["number"] == "GR-000001"


def test_simultaneous_creations_with_one_key_make_one_receipt(api, order, bolt_line, client):
    statuses, ids = [], []

    def go():
        response = client.post(RECEIPTS, json={"purchase_order_id": order["id"], "lines": [bolt_line(1)]}, headers={**api.headers, "Idempotency-Key": "receipt-key-race"})
        statuses.append(response.status_code)
        if response.status_code in (200, 201):
            ids.append(response.json()["id"])

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert statuses.count(201) == 1 and len(set(ids)) == 1 and set(statuses) <= {200, 201, 409}
    assert api.client.get(RECEIPTS, headers=api.headers).json()["total"] == 1


def test_creation_requires_a_well_formed_key(api, order):
    no_key = api.client.post(RECEIPTS, json={"purchase_order_id": order["id"]}, headers=api.headers)
    assert no_key.status_code == 400
    assert api.receipt(order["id"], [], key="short").status_code == 400


# =====================================================================================================
# The list
# =====================================================================================================
def test_the_list_filters_and_searches(api, shop, inventory, order, bolt_line, flour_line):
    other = api.ordered(shop, lines=(("bolt", 9),), supplier="Zenith Ltd")
    first = api.confirm(api.draft(order["id"], [bolt_line(5)], supplier_reference="DN-777", received_date="2026-11-02")["id"]).json()
    second = api.draft(other["id"], [received(other, shop["bolt"], 2)], received_date="2026-11-03")
    cancelled = api.draft(order["id"], [flour_line(1)], received_date="2026-11-04")
    api.cancel_receipt(cancelled["id"])

    def ids(**params):
        body = api.client.get(RECEIPTS, params=params, headers=api.headers).json()
        return [i["id"] for i in body["items"]]

    assert ids() == [cancelled["id"], second["id"], first["id"]]  # newest receiving date first
    assert ids(status="confirmed") == [first["id"]] and ids(status="draft") == [second["id"]] and ids(status="cancelled") == [cancelled["id"]]
    assert ids(purchase_order_id=other["id"]) == [second["id"]]
    assert ids(supplier_id=other["supplier"]["id"]) == [second["id"]]
    assert ids(product_id=shop["bolt"]) == [second["id"], first["id"]] and ids(product_id=shop["flour"]) == [cancelled["id"]]
    assert ids(q="DN-777") == [first["id"]] and ids(q="zenith") == [second["id"]] and ids(q="GR-000002") == [second["id"]] and ids(q="PO-000002") == [second["id"]]
    assert ids(date_from="2026-11-03", date_to="2026-11-03") == [second["id"]]
    page = api.client.get(RECEIPTS, params={"limit": 2, "offset": 2}, headers=api.headers).json()
    assert page["total"] == 3 and len(page["items"]) == 1
    summary = page["items"][0]
    assert summary["supplier"]["name"] == "Acme Supplies" and summary["purchase_order"]["number"] == "PO-000001" and summary["line_count"] == 1


# =====================================================================================================
# Concurrent edits
# =====================================================================================================
def test_saving_lines_while_confirming_leaves_a_consistent_receipt(api, shop, inventory, order, bolt_line, client):
    draft = api.draft(order["id"], [bolt_line(10)])
    results = {}

    def confirm():
        results["confirm"] = client.post(f"{RECEIPTS}/{draft['id']}/confirm", headers=api.headers).status_code

    def edit():
        results["edit"] = client.put(f"{RECEIPTS}/{draft['id']}/lines", json={"lines": [bolt_line(4)]}, headers=api.headers).status_code

    threads = [threading.Thread(target=confirm), threading.Thread(target=edit)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    final = api.get_receipt(draft["id"])
    posted = inventory.ledger[0]["quantity"] if inventory.ledger else None
    # whatever order they ran in, the goods added are exactly the lines the receipt ended up with
    assert final["status"] == "confirmed" and results["confirm"] == 200
    assert d(posted) == d(final["lines"][0]["accepted_quantity"]) and results["edit"] in (200, 409)
    assert stock(inventory, shop, "bolt") == 40 + d(posted)


def test_the_database_rows_match_the_story(api, shop, inventory, order, bolt_line, session_factory):
    draft = api.draft(order["id"], [bolt_line(10)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    with session_factory() as db:
        row = db.execute(text("SELECT status, posting_key, posting_attempts, inventory_operation_id FROM goods_receipts WHERE id = :id"), {"id": uuid.UUID(draft["id"])}).one()
    assert row.status == "posting" and row.posting_key == f"goods-receipt-{draft['id']}" and row.posting_attempts == 1 and row.inventory_operation_id is None
