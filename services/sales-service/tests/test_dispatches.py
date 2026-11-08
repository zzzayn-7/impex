"""Client dispatch: drafts, partial dispatches, the durable confirm workflow, over-dispatch, failures between the two services."""
import threading
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import DISPATCHES, LISTS, item_of, sent


def d(value) -> Decimal:
    return Decimal(str(value))


@pytest.fixture
def depot(inventory, shop):
    """The shop, with exactly 40 bolts in stock."""
    inventory.set_stock(shop["bolt"], 40)
    return shop


@pytest.fixture
def ready(api, depot):
    """DL-000001 for Acme: 15 bolts and 2 kg of flour, Ready."""
    return api.ready_list(depot)


@pytest.fixture
def bolt_line(ready, depot):
    return lambda quantity: sent(ready, depot["bolt"], quantity)


@pytest.fixture
def flour_line(ready, depot):
    return lambda quantity: sent(ready, depot["flour"], quantity)


def stock(inventory, depot, product) -> Decimal:
    return inventory.quantity(depot[product])


# =====================================================================================================
# Dispatching in full
# =====================================================================================================
def test_a_full_dispatch_deducts_the_goods_and_completes_the_list(api, depot, inventory, ready, bolt_line, flour_line):
    draft = api.draft(ready["id"], [bolt_line(15), flour_line(2)], tracking_reference="TRK-77", delivery_address="1 Dock Rd", transport_details="Truck 4")
    assert draft["number"] == "DS-000001" and draft["status"] == "draft" and draft["editable"] is True
    assert (draft["tracking_reference"], draft["delivery_address"], draft["transport_details"]) == ("TRK-77", "1 Dock Rd", "Truck 4")
    assert draft["delivery_list"]["number"] == "DL-000001" and draft["client"]["name"] == "Acme Ltd"
    assert stock(inventory, depot, "bolt") == 40 and inventory.postings() == [] and inventory.writes() == []  # a draft deducts nothing

    response = api.confirm(draft["id"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "confirmed" and body["confirmed_by_email"] == "admin-alpha@example.org" and body["inventory_operation_id"] and body["editable"] is False
    assert all(l["inventory_movement_id"] for l in body["lines"])
    assert stock(inventory, depot, "bolt") == 25 and stock(inventory, depot, "flour") == d("0.5")

    after = api.detail(ready["id"])
    assert after["status"] == "dispatched" and after["can_dispatch"] is False
    assert [(i["quantity"], i["dispatched_quantity"], i["pending_quantity"], i["remaining_quantity"]) for i in after["items"]] == [
        ("15.0000", "15.0000", "0.0000", "0.0000"), ("2.0000", "2.0000", "0.0000", "0.0000")]
    assert [(x["number"], x["status"]) for x in after["dispatches"]] == [("DS-000001", "confirmed")]


def test_the_inventory_service_is_asked_once_with_a_key_made_from_the_dispatch_id(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(4)])
    api.confirm(draft["id"])
    (posting,) = inventory.postings()
    assert posting[2] == "admin-alpha"  # the caller's own token, never a service credential
    (key,) = [k for (_, k) in inventory.operations]
    assert key == f"dispatch-{draft['id']}"


def test_the_posting_carries_only_ids_quantities_and_units_never_a_price(api, depot, inventory, ready, bolt_line, monkeypatch):
    seen = []
    original = inventory._post_dispatch

    def spy(org, request):
        seen.append(json.loads(request.content))
        return original(org, request)

    import json
    monkeypatch.setattr(inventory, "_post_dispatch", spy)
    api.confirm(api.draft(ready["id"], [bolt_line(4)])["id"])
    (body,) = seen
    assert set(body) == {"dispatch_number", "delivery_list_number", "lines"} and body["delivery_list_number"] == "DL-000001"
    assert all(set(l) == {"line_id", "product_id", "quantity", "unit"} for l in body["lines"])  # no warehouse, no price


# =====================================================================================================
# Partial dispatching: the 15 laptops example
# =====================================================================================================
def test_ten_of_fifteen_then_the_remaining_five(api, depot, inventory, ready, bolt_line):
    first = api.draft(ready["id"], [bolt_line(10)])
    assert api.confirm(first["id"]).status_code == 200
    mid = api.detail(ready["id"])
    bolts = item_of(mid, depot["bolt"])
    assert mid["status"] == "partially_dispatched" and mid["can_dispatch"] is True
    assert (bolts["quantity"], bolts["dispatched_quantity"], bolts["remaining_quantity"]) == ("15.0000", "10.0000", "5.0000")
    assert stock(inventory, depot, "bolt") == 30

    second = api.draft(ready["id"], [bolt_line(5)])
    (line,) = second["lines"]
    assert (line["requested_quantity"], line["dispatched_elsewhere_quantity"], line["dispatchable_quantity"]) == ("15.0000", "10.0000", "5.0000")
    assert api.confirm(second["id"]).status_code == 200
    after = api.detail(ready["id"])
    assert after["status"].startswith("partially") and item_of(after, depot["flour"])["remaining_quantity"] == "2.0000"  # the flour is still to go
    assert item_of(after, depot["bolt"])["remaining_quantity"] == "0.0000" and stock(inventory, depot, "bolt") == 25

    third = api.draft(ready["id"], [sent(after, depot["flour"], 2)])
    assert api.confirm(third["id"]).status_code == 200
    assert api.detail(ready["id"])["status"] == "dispatched"
    assert [r["number"] for r in api.detail(ready["id"])["dispatches"]] == ["DS-000003", "DS-000002", "DS-000001"]  # newest first


def test_a_dispatch_names_no_warehouse_anywhere(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(10)])
    confirmed = api.confirm(draft["id"])
    assert confirmed.status_code == 200
    for text_of in (str(draft), confirmed.text, str(api.detail(ready["id"]))):
        assert "warehouse" not in text_of.lower()
    assert stock(inventory, depot, "bolt") == 30
    assert item_of(api.detail(ready["id"]), depot["bolt"])["dispatched_quantity"] == "10.0000"


def test_every_line_makes_a_traceable_movement(api, depot, inventory, ready, bolt_line, flour_line):
    confirmed = api.confirm(api.draft(ready["id"], [bolt_line(15), flour_line(2)])["id"]).json()
    assert len(inventory.ledger) == 2
    by_product = {m["product_id"]: m for m in inventory.ledger}
    assert by_product[depot["bolt"]]["source_reference"] == "DS-000001"
    assert by_product[depot["bolt"]]["balance_after"] == "25.0000" and by_product[depot["flour"]]["balance_after"] == "0.5000"
    assert {l["inventory_movement_id"] for l in confirmed["lines"]} == {m["id"] for m in inventory.ledger}


# =====================================================================================================
# No over-dispatch
# =====================================================================================================
def test_more_than_requested_is_refused_when_saving(api, ready, bolt_line):
    response = api.dispatch_request(ready["id"], [bolt_line(16)])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "over_dispatch" and "at most 15" in response.json()["detail"]["message"]


def test_more_than_remains_is_refused_after_a_partial_dispatch(api, ready, bolt_line):
    api.confirm(api.draft(ready["id"], [bolt_line(12)])["id"])
    response = api.dispatch_request(ready["id"], [bolt_line(4)])
    assert response.status_code == 409 and "12 already dispatched" in response.json()["detail"]["message"]
    assert api.dispatch_request(ready["id"], [bolt_line(3)]).status_code == 201


def test_two_drafts_may_each_ask_for_everything_but_only_one_can_be_confirmed(api, depot, inventory, ready, bolt_line):
    one, two = api.draft(ready["id"], [bolt_line(15)]), api.draft(ready["id"], [bolt_line(15)])  # drafts reserve nothing
    assert api.confirm(one["id"]).status_code == 200
    refused = api.confirm(two["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "over_dispatch" and "at most 0" in refused.json()["detail"]["message"]
    assert api.get_dispatch(two["id"])["status"] == "draft"
    assert stock(inventory, depot, "bolt") == 25


def test_two_administrators_cannot_over_dispatch_the_same_list_at_the_same_moment(api, depot, inventory, ready, bolt_line, client):
    drafts = [api.draft(ready["id"], [bolt_line(8)]) for _ in range(4)]
    results, refusals = [], []

    def go(dispatch):
        response = client.post(f"{DISPATCHES}/{dispatch['id']}/confirm", headers=api.headers)
        results.append(response.status_code)
        if response.status_code == 409:
            refusals.append(response.json()["detail"])

    threads = [threading.Thread(target=go, args=(x,)) for x in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200, 409, 409, 409]  # 8 of 15 fits once; a second 8 does not
    assert all(isinstance(r, dict) and r["code"] == "over_dispatch" for r in refusals), refusals
    assert stock(inventory, depot, "bolt") == 32 and len(inventory.ledger) == 1
    assert api.detail(ready["id"])["status"] == "partially_dispatched"


def test_concurrent_dispatches_that_fit_together_all_succeed(api, depot, inventory, ready, bolt_line, client):
    drafts = [api.draft(ready["id"], [bolt_line(3)]) for _ in range(5)]
    results = []

    def go(dispatch):
        results.append(client.post(f"{DISPATCHES}/{dispatch['id']}/confirm", headers=api.headers).status_code)

    threads = [threading.Thread(target=go, args=(x,)) for x in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert results == [200] * 5 and stock(inventory, depot, "bolt") == 25


def test_confirming_the_same_dispatch_many_times_at_once_deducts_once(api, depot, inventory, ready, bolt_line, client):
    draft = api.draft(ready["id"], [bolt_line(15)])
    results = []

    def go():
        results.append(client.post(f"{DISPATCHES}/{draft['id']}/confirm", headers=api.headers).status_code)

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert set(results) <= {200, 202} and 200 in results
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1
    assert api.get_dispatch(draft["id"])["status"] == "confirmed"


# =====================================================================================================
# Stock: never negative, nothing deducted before confirmation
# =====================================================================================================
def test_not_enough_stock_keeps_the_draft_and_deducts_nothing(api, depot, inventory, ready, bolt_line, flour_line):
    big = api.ready_list(depot, items=(("bolt", 50),), client_name="Big")
    draft = api.draft(big["id"], [sent(big, depot["bolt"], 45)])  # saving is fine: stock may arrive before dispatch
    assert draft["lines_exceeding_stock"] == 1 and d(draft["lines"][0]["available_quantity"]) == 40
    refused = api.confirm(draft["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "insufficient_stock" and "40 pcs of Steel bolt in stock" in refused.json()["detail"]["message"]
    assert api.get_dispatch(draft["id"])["status"] == "draft" and inventory.postings() == [] and stock(inventory, depot, "bolt") == 40
    assert api.detail(big["id"])["status"] == "ready" and item_of(api.detail(big["id"]), depot["bolt"])["pending_quantity"] == "0.0000"
    api.put_lines(draft["id"], [sent(big, depot["bolt"], 40)])  # edited down to what is there: now it goes
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, depot, "bolt") == 0


def test_the_inventory_service_refusing_for_lack_of_stock_returns_the_dispatch_to_draft(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["reject"]
    refused = api.confirm(draft["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "inventory_rejected"
    receipt = api.get_dispatch(draft["id"])
    assert receipt["status"] == "draft" and receipt["editable"] is True and "archived" in receipt["posting"]["last_error"]
    assert stock(inventory, depot, "bolt") == 40 and item_of(api.detail(ready["id"]), depot["bolt"])["pending_quantity"] == "0.0000"
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, depot, "bolt") == 25


def test_stock_taken_by_someone_else_between_the_check_and_the_posting_is_refused_cleanly(api, depot, inventory, ready, bolt_line, monkeypatch):
    draft = api.draft(ready["id"], [bolt_line(15)])
    from app.inventory import InventoryGateway

    original = InventoryGateway.post_dispatch

    def late(self, key, body):
        inventory.stock[depot["bolt"]] = Decimal(3)  # a colleague shipped the stock a moment ago
        return original(self, key, body)

    monkeypatch.setattr(InventoryGateway, "post_dispatch", late)
    refused = api.confirm(draft["id"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "inventory_rejected" and "Insufficient stock" in refused.json()["detail"]["message"]
    assert api.get_dispatch(draft["id"])["status"] == "draft" and inventory.ledger == [] and stock(inventory, depot, "bolt") == 3


def test_drafting_editing_cancelling_and_scanning_never_post_to_inventory(api, depot, inventory, ready, bolt_line, flour_line):
    snapshot = inventory.snapshot()
    draft = api.draft(ready["id"], [bolt_line(3)])
    api.put_lines(draft["id"], [bolt_line(4), flour_line(1)])
    api.client.patch(f"{DISPATCHES}/{draft['id']}", json={"notes": "n"}, headers=api.headers)
    api.get_dispatch(draft["id"])
    api.cancel_dispatch(draft["id"])
    api.client.get(DISPATCHES, headers=api.headers)
    api.detail(ready["id"])
    assert inventory.writes() == [] and inventory.snapshot() == snapshot and inventory.ledger == []


def test_the_only_write_ever_made_is_the_posting_of_a_confirmed_dispatch(api, ready, inventory, bolt_line):
    api.confirm(api.draft(ready["id"], [bolt_line(3)])["id"])
    assert [(m, p) for m, p, _ in inventory.writes()] == [("POST", "/api/v1/inventory/dispatches")]


# =====================================================================================================
# Failures between the two services
# =====================================================================================================
def test_when_the_answer_is_lost_after_inventory_committed_a_retry_finishes_without_deducting_twice(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["timeout_after"]
    inventory.lookup_mode = "500"  # and the status check cannot reach it either
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202
    body = pending.json()
    assert body["status"] == "posting" and body["posting"]["attempts"] == 1 and "did not answer" in body["posting"]["last_error"]
    assert stock(inventory, depot, "bolt") == 25  # Inventory DID deduct it...
    assert api.detail(ready["id"])["status"] == "ready"  # ...but Sales does not claim it is dispatched until it has verified that
    assert item_of(api.detail(ready["id"]), depot["bolt"])["pending_quantity"] == "15.0000"  # the quantity stays reserved meanwhile

    inventory.lookup_mode = None
    done = api.confirm(draft["id"])
    assert done.status_code == 200 and done.json()["status"] == "confirmed" and done.json()["posting"]["attempts"] == 2
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1
    assert {key for (_, key) in inventory.operations} == {f"dispatch-{draft['id']}"}  # the same key both times
    assert api.detail(ready["id"])["status"] == "partially_dispatched"


def test_a_lost_answer_is_recovered_by_asking_inventory_what_happened(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["timeout_after"]
    done = api.confirm(draft["id"])
    assert done.status_code == 200 and done.json()["status"] == "confirmed"
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1


def test_a_500_after_inventory_committed_is_recovered_too(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["500_after"]
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1


def test_when_inventory_never_received_the_request_nothing_is_deducted_and_a_retry_posts_it(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["timeout_before"]
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202 and pending.json()["status"] == "posting"
    assert stock(inventory, depot, "bolt") == 40 and inventory.ledger == []
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1


def test_inventory_failing_before_doing_anything_leaves_a_retryable_posting(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["500_before"]
    assert api.confirm(draft["id"]).status_code == 202
    dispatch = api.get_dispatch(draft["id"])
    assert dispatch["status"] == "posting" and "failed (500)" in dispatch["posting"]["last_error"]
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, depot, "bolt") == 25


def test_a_posting_dispatch_is_frozen_and_its_goods_are_reserved(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    other = api.draft(ready["id"], [bolt_line(1)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    assert api.put_lines(draft["id"], [bolt_line(1)]).status_code == 409
    assert api.client.patch(f"{DISPATCHES}/{draft['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    cancelled = api.cancel_dispatch(draft["id"])
    assert cancelled.status_code == 409 and "being deducted" in cancelled.json()["detail"]
    refused = api.confirm(other["id"])  # the posting has reserved all 15
    assert refused.status_code == 409 and "being posted" in refused.json()["detail"]["message"]
    assert api.dispatch_request(ready["id"], [bolt_line(1)]).status_code == 409


def test_an_answer_that_does_not_match_the_dispatch_is_not_trusted(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["wrong_answer"]
    inventory.lookup_mode = "500"
    pending = api.confirm(draft["id"])
    assert pending.status_code == 202 and "did not match" in pending.json()["posting"]["last_error"]
    assert api.get_dispatch(draft["id"])["status"] == "posting"
    inventory.lookup_mode = None
    assert api.confirm(draft["id"]).status_code == 200  # the replayed (correct) answer verifies


def test_a_crash_after_inventory_committed_but_before_sales_recorded_it_is_recoverable(api, depot, inventory, ready, bolt_line, monkeypatch):
    from app import dispatches

    draft = api.draft(ready["id"], [bolt_line(15)])

    def crash(*args, **kwargs):
        raise RuntimeError("the process was killed")

    monkeypatch.setattr(dispatches, "_finish", crash)
    with pytest.raises(RuntimeError):
        api.confirm(draft["id"])
    monkeypatch.undo()
    assert stock(inventory, depot, "bolt") == 25  # inventory has deducted it
    assert api.get_dispatch(draft["id"])["status"] == "posting"  # sales has the saved intent
    assert api.confirm(draft["id"]).status_code == 200
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.ledger) == 1


def test_a_crash_right_after_the_intent_was_saved_is_recoverable(api, depot, inventory, ready, bolt_line, monkeypatch):
    draft = api.draft(ready["id"], [bolt_line(15)])
    from app.inventory import InventoryGateway

    def crash(self, key, body):
        raise RuntimeError("the process was killed before anything was sent")

    monkeypatch.setattr(InventoryGateway, "post_dispatch", crash)
    with pytest.raises(RuntimeError):
        api.confirm(draft["id"])
    monkeypatch.undo()
    assert stock(inventory, depot, "bolt") == 40 and api.get_dispatch(draft["id"])["status"] == "posting"
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, depot, "bolt") == 25


def test_inventory_down_at_confirmation_explains_and_changes_nothing(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.mode = "down"
    response = api.confirm(draft["id"])
    assert response.status_code == 503 and "inventory service is unavailable" in response.json()["detail"]
    inventory.mode = None
    assert api.get_dispatch(draft["id"])["status"] == "draft" and inventory.ledger == []
    assert api.confirm(draft["id"]).status_code == 200


def test_an_expired_token_at_posting_time_keeps_the_dispatch_posting(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    inventory.mode = "401"
    assert api.confirm(draft["id"]).status_code == 401
    inventory.mode = None
    assert api.get_dispatch(draft["id"])["status"] == "posting"
    assert api.confirm(draft["id"]).status_code == 200


def test_a_dispatch_is_never_confirmed_on_hope(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    for mode in ("timeout_before", "500_before", "wrong_answer", "500_before"):
        inventory.post_modes = [mode]
        inventory.lookup_mode = "500"
        assert api.confirm(draft["id"]).status_code == 202
        dispatch = api.get_dispatch(draft["id"])
        assert dispatch["status"] == "posting" and dispatch["confirmed_at"] is None and dispatch["inventory_operation_id"] is None
        assert all(l["inventory_movement_id"] is None for l in dispatch["lines"])
    assert api.get_dispatch(draft["id"])["posting"]["attempts"] == 4


def test_confirming_twice_changes_nothing_the_second_time(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    first, second = api.confirm(draft["id"]), api.confirm(draft["id"])
    assert (first.status_code, second.status_code) == (200, 200)
    assert second.json()["confirmed_at"] == first.json()["confirmed_at"] and second.json()["inventory_operation_id"] == first.json()["inventory_operation_id"]
    assert stock(inventory, depot, "bolt") == 25 and len(inventory.postings()) == 1 and len(inventory.ledger) == 1


# =====================================================================================================
# Validation
# =====================================================================================================
@pytest.mark.parametrize("quantity", ["2.5", "14.0001"])
def test_whole_units_need_whole_quantities(api, ready, bolt_line, quantity):
    response = api.dispatch_request(ready["id"], [bolt_line(quantity)])
    assert response.status_code == 422 and "whole number" in response.json()["detail"]


def test_measurable_units_accept_fractions(api, depot, inventory, ready, flour_line):
    draft = api.draft(ready["id"], [flour_line("1.25")])
    assert api.confirm(draft["id"]).status_code == 200 and stock(inventory, depot, "flour") == d("1.25")


@pytest.mark.parametrize("quantity", ["0", "-1", "abc", "1.00001", "100000000000000000", None])
def test_bad_quantities_are_refused(api, ready, bolt_line, quantity):
    line = bolt_line(1)
    line["quantity"] = quantity
    assert api.dispatch_request(ready["id"], [line]).status_code == 422


def test_a_line_that_names_a_warehouse_is_refused(api, ready, bolt_line):
    response = api.dispatch_request(ready["id"], [{**bolt_line(1), "warehouse_id": str(uuid.uuid4())}])
    assert response.status_code == 422  # there is no warehouse to name any more


def test_archived_products_are_refused(api, depot, inventory, ready, bolt_line):
    inventory.products[depot["org"]][depot["bolt"]]["is_active"] = False
    product = api.dispatch_request(ready["id"], [bolt_line(1)])
    assert product.status_code == 409 and "Steel bolt is archived" in product.json()["detail"]


def test_a_product_archived_after_the_draft_was_saved_is_caught_before_anything_is_reserved(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.products[depot["org"]][depot["bolt"]]["is_active"] = False
    response = api.confirm(draft["id"])
    assert response.status_code == 409 and "archived" in response.json()["detail"]
    assert api.get_dispatch(draft["id"])["status"] == "draft" and inventory.postings() == []


def test_a_unit_changed_since_listing_is_refused_and_never_converted(api, depot, inventory, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.products[depot["org"]][depot["bolt"]]["unit"] = "box"
    response = api.confirm(draft["id"])
    assert response.status_code == 409 and "never converted" in response.json()["detail"]
    assert stock(inventory, depot, "bolt") == 40 and inventory.postings() == []


def test_an_item_that_is_not_on_the_list_is_refused(api, depot, ready, bolt_line):
    other = api.ready_list(depot, items=(("bolt", 3),), client_name="Other")
    foreign = sent(other, depot["bolt"], 1)  # the item id of ANOTHER list
    response = api.dispatch_request(ready["id"], [foreign])
    assert response.status_code == 404 and response.json()["detail"] == "That product is not on this delivery list."
    assert api.dispatch_request(ready["id"], [{**bolt_line(1), "delivery_list_item_id": str(uuid.uuid4())}]).json()["detail"] == response.json()["detail"]


def test_the_same_item_twice_is_refused(api, ready, bolt_line):
    response = api.dispatch_request(ready["id"], [bolt_line(1), bolt_line(2)])
    assert response.status_code == 422 and "more than once" in response.json()["detail"]


def test_unknown_and_forbidden_fields_are_refused(api, ready, bolt_line):
    for extra in ({"organization_id": str(uuid.uuid4())}, {"status": "confirmed"}, {"number": "DS-999"}, {"posting_key": "x"}, {"client_id": str(uuid.uuid4())}):
        assert api.dispatch_request(ready["id"], [], **extra).status_code == 422
    for field in ("product_id", "unit", "unit_price", "product_name", "inventory_movement_id"):
        assert api.dispatch_request(ready["id"], [{**bolt_line(1), field: "x"}]).status_code == 422, field


def test_the_dispatch_date_cannot_be_in_the_future(api, ready):
    assert api.dispatch_request(ready["id"], [], dispatch_date="2999-01-01").status_code == 422
    assert api.dispatch_request(ready["id"], [], dispatch_date="2026-11-01").status_code == 201


def test_a_dispatch_without_lines_cannot_be_confirmed(api, ready, inventory):
    empty = api.draft(ready["id"], [])
    response = api.confirm(empty["id"])
    assert response.status_code == 422 and "no lines" in response.json()["detail"] and inventory.postings() == []


# =====================================================================================================
# Delivery-list status rules
# =====================================================================================================
def test_goods_are_dispatched_only_against_ready_or_partially_dispatched_lists(api, depot, ready, bolt_line):
    draft_list = api.new_list(api.new_client("Fresh")["id"])
    api.add(draft_list["id"], depot["bolt"], 3)
    response = api.dispatch_request(draft_list["id"], [])
    assert response.status_code == 409 and "still a draft" in response.json()["detail"]

    cancelled = api.ready_list(depot, items=(("bolt", 2),), client_name="Gone")
    api.status(cancelled["id"], "cancel")
    assert "is cancelled" in api.dispatch_request(cancelled["id"], []).json()["detail"]

    done = api.ready_list(depot, items=(("bolt", 2),), client_name="Done")
    api.confirm(api.draft(done["id"], [sent(done, depot["bolt"], 2)])["id"])
    assert "already fully dispatched" in api.dispatch_request(done["id"], []).json()["detail"]


def test_a_list_with_dispatches_cannot_be_reopened_or_edited(api, depot, ready, bolt_line):
    api.confirm(api.draft(ready["id"], [bolt_line(4)])["id"])
    reopen = api.status(ready["id"], "reopen")
    assert reopen.status_code == 409 and "can no longer be reopened" in reopen.json()["detail"]
    item = item_of(api.detail(ready["id"]), depot["bolt"])
    assert api.client.patch(f"{LISTS}/{ready['id']}/items/{item['id']}", json={"quantity": "99"}, headers=api.headers).status_code == 409
    assert api.client.delete(f"{LISTS}/{ready['id']}/items/{item['id']}", headers=api.headers).status_code == 409
    assert api.add(ready["id"], depot["old"], 1).status_code == 409
    assert api.client.patch(f"{LISTS}/{ready['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409


def test_a_list_with_goods_dispatched_or_being_dispatched_cannot_be_cancelled(api, depot, inventory, ready, bolt_line):
    posting = api.draft(ready["id"], [bolt_line(4)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(posting["id"])
    blocked = api.status(ready["id"], "cancel")
    assert blocked.status_code == 409 and "cannot be cancelled" in blocked.json()["detail"]
    assert api.status(ready["id"], "reopen").status_code == 409
    api.confirm(posting["id"])
    assert api.detail(ready["id"])["status"] == "partially_dispatched"
    blocked = api.status(ready["id"], "cancel")
    assert blocked.status_code == 409 and "already has goods dispatched" in blocked.json()["detail"]


def test_cancelling_or_reopening_a_list_cancels_its_unfinished_drafts(api, depot, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(2)])
    assert api.status(ready["id"], "reopen").status_code == 200
    assert api.get_dispatch(draft["id"])["status"] == "cancelled" and api.detail(ready["id"])["status"] == "draft"

    other = api.ready_list(depot, items=(("bolt", 5),), client_name="Other")
    pending = api.draft(other["id"], [sent(other, depot["bolt"], 2)])
    assert api.status(other["id"], "cancel").status_code == 200
    assert api.get_dispatch(pending["id"])["status"] == "cancelled"


def test_a_list_without_dispatches_still_behaves_as_before(api, depot):
    created = api.new_list(api.new_client("Plain")["id"])
    api.add(created["id"], depot["bolt"], 3)
    assert api.status(created["id"], "ready").json()["status"] == "ready"
    assert api.status(created["id"], "reopen").json()["status"] == "draft"
    assert api.status(created["id"], "ready").json()["status"] == "ready"
    assert api.status(created["id"], "cancel").json()["status"] == "cancelled"
    detail = api.detail(created["id"])
    assert detail["dispatches"] == [] and detail["can_dispatch"] is False
    assert [(i["dispatched_quantity"], i["remaining_quantity"]) for i in detail["items"]] == [("0.0000", "3.0000")]


# =====================================================================================================
# Dispatch statuses
# =====================================================================================================
def test_a_confirmed_dispatch_is_permanent(api, ready, bolt_line):
    confirmed = api.confirm(api.draft(ready["id"], [bolt_line(4)])["id"]).json()
    assert api.put_lines(confirmed["id"], [bolt_line(1)]).status_code == 409
    assert api.client.patch(f"{DISPATCHES}/{confirmed['id']}", json={"notes": "x"}, headers=api.headers).status_code == 409
    cancelled = api.cancel_dispatch(confirmed["id"])
    assert cancelled.status_code == 409 and "cannot be cancelled" in cancelled.json()["detail"]
    assert api.client.delete(f"{DISPATCHES}/{confirmed['id']}", headers=api.headers).status_code == 405
    assert api.get_dispatch(confirmed["id"])["lines"][0]["quantity"] == "4.0000"


def test_a_draft_can_be_edited_and_cancelled_and_a_cancelled_one_stays(api, depot, inventory, ready, bolt_line, flour_line):
    draft = api.draft(ready["id"], [bolt_line(2)], notes="first")
    edited = api.client.patch(f"{DISPATCHES}/{draft['id']}", json={"notes": "second", "tracking_reference": "TRK-2", "delivery_address": "Gate 5"}, headers=api.headers).json()
    assert (edited["notes"], edited["tracking_reference"], edited["delivery_address"]) == ("second", "TRK-2", "Gate 5")
    replaced = api.put_lines(draft["id"], [flour_line(1)]).json()
    assert [l["product_name"] for l in replaced["lines"]] == ["Flour"]
    cancelled = api.cancel_dispatch(draft["id"])
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled" and cancelled.json()["cancelled_by_email"]
    assert api.cancel_dispatch(draft["id"]).status_code == 200  # repeating is harmless
    assert api.confirm(draft["id"]).status_code == 409 and api.put_lines(draft["id"], []).status_code == 409
    assert api.get_dispatch(draft["id"])["status"] == "cancelled" and inventory.postings() == []


def test_cancelling_a_draft_frees_nothing_because_a_draft_reserves_nothing(api, depot, ready, bolt_line):
    draft = api.draft(ready["id"], [bolt_line(15)])
    api.cancel_dispatch(draft["id"])
    assert item_of(api.detail(ready["id"]), depot["bolt"])["remaining_quantity"] == "15.0000"


# =====================================================================================================
# History, prices, numbers, idempotent creation
# =====================================================================================================
def test_the_delivery_list_keeps_its_history_untouched(api, depot, ready, bolt_line):
    before = api.detail(ready["id"])
    api.confirm(api.draft(ready["id"], [bolt_line(15)])["id"])
    after = api.detail(ready["id"])
    keep = ("product_id", "product_sku", "product_name", "quantity", "unit", "created_at")
    assert [{k: i[k] for k in keep} for i in after["items"]] == [{k: i[k] for k in keep} for i in before["items"]]
    assert (after["number"], after["client"]["name"], after["created_at"]) == (before["number"], before["client"]["name"], before["created_at"])


def test_numbers_run_per_organization(api, two_orgs, depot, inventory, ready, bolt_line):
    assert [api.draft(ready["id"], [bolt_line(1)])["number"] for _ in range(3)] == ["DS-000001", "DS-000002", "DS-000003"]
    beta = two_orgs["beta"]
    product = inventory.add_product(two_orgs["beta_id"], "B-1", "Beta thing")
    inventory.set_stock(product, 9)
    theirs = beta.ready_list({"thing": product}, items=(("thing", 4),))
    assert beta.draft(theirs["id"], [sent(theirs, product, 1)])["number"] == "DS-000001"


def test_a_repeated_creation_returns_the_same_draft(api, ready, bolt_line):
    first = api.dispatch_request(ready["id"], [bolt_line(2)], key="dispatch-key-0001")
    again = api.dispatch_request(ready["id"], [bolt_line(2)], key="dispatch-key-0001")
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["id"] == again.json()["id"]
    different = api.dispatch_request(ready["id"], [bolt_line(3)], key="dispatch-key-0001")
    assert different.status_code == 409 and "different request" in different.json()["detail"]
    assert len(api.client.get(DISPATCHES, headers=api.headers).json()["items"]) == 1


def test_a_failed_creation_does_not_burn_its_key_or_a_number(api, ready, bolt_line):
    assert api.dispatch_request(ready["id"], [bolt_line(16)], key="dispatch-key-0002").status_code == 409
    ok = api.dispatch_request(ready["id"], [bolt_line(1)], key="dispatch-key-0002")
    assert ok.status_code == 201 and ok.json()["number"] == "DS-000001"


def test_simultaneous_creations_with_one_key_make_one_dispatch(api, ready, bolt_line, client):
    statuses, ids = [], []

    def go():
        response = client.post(DISPATCHES, json={"delivery_list_id": ready["id"], "lines": [bolt_line(1)]}, headers={**api.headers, "Idempotency-Key": "dispatch-key-race"})
        statuses.append(response.status_code)
        if response.status_code in (200, 201):
            ids.append(response.json()["id"])

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert statuses.count(201) == 1 and len(set(ids)) == 1 and set(statuses) <= {200, 201, 409}
    assert api.client.get(DISPATCHES, headers=api.headers).json()["total"] == 1


def test_creation_requires_a_well_formed_key(api, ready):
    assert api.client.post(DISPATCHES, json={"delivery_list_id": ready["id"]}, headers=api.headers).status_code == 400
    assert api.dispatch_request(ready["id"], [], key="short").status_code == 400


# =====================================================================================================
# The list
# =====================================================================================================
def test_the_list_filters_and_searches(api, depot, inventory, ready, bolt_line, flour_line):
    other = api.ready_list(depot, items=(("bolt", 9),), client_name="Zenith Ltd")
    first = api.confirm(api.draft(ready["id"], [bolt_line(5)], tracking_reference="TRK-777", dispatch_date="2026-11-02")["id"]).json()
    second = api.draft(other["id"], [sent(other, depot["bolt"], 2)], dispatch_date="2026-11-03")
    cancelled = api.draft(ready["id"], [flour_line(1)], dispatch_date="2026-11-04")
    api.cancel_dispatch(cancelled["id"])

    def ids(**params):
        return [i["id"] for i in api.client.get(DISPATCHES, params=params, headers=api.headers).json()["items"]]

    assert ids() == [cancelled["id"], second["id"], first["id"]]  # newest dispatch date first
    assert ids(status="confirmed") == [first["id"]] and ids(status="draft") == [second["id"]] and ids(status="cancelled") == [cancelled["id"]]
    assert ids(delivery_list_id=other["id"]) == [second["id"]] and ids(client_id=other["client"]["id"]) == [second["id"]]
    assert ids(product_id=depot["bolt"]) == [second["id"], first["id"]] and ids(product_id=depot["flour"]) == [cancelled["id"]]
    assert ids(q="TRK-777") == [first["id"]] and ids(q="zenith") == [second["id"]] and ids(q="DS-000002") == [second["id"]] and ids(q="DL-000002") == [second["id"]]
    assert ids(date_from="2026-11-03", date_to="2026-11-03") == [second["id"]]
    page = api.client.get(DISPATCHES, params={"limit": 2, "offset": 2}, headers=api.headers).json()
    assert page["total"] == 3 and len(page["items"]) == 1
    assert page["items"][0]["client"]["name"] == "Acme Ltd" and page["items"][0]["delivery_list"]["number"] == "DL-000001" and page["items"][0]["line_count"] == 1


def test_saving_lines_while_confirming_leaves_a_consistent_dispatch(api, depot, inventory, ready, bolt_line, client):
    draft = api.draft(ready["id"], [bolt_line(15)])
    results = {}

    def confirm():
        results["confirm"] = client.post(f"{DISPATCHES}/{draft['id']}/confirm", headers=api.headers).status_code

    def edit():
        results["edit"] = client.put(f"{DISPATCHES}/{draft['id']}/lines", json={"lines": [bolt_line(4)]}, headers=api.headers).status_code

    threads = [threading.Thread(target=confirm), threading.Thread(target=edit)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    final = api.get_dispatch(draft["id"])
    # whatever order they ran in, the goods deducted are exactly the lines the dispatch ended up with
    assert final["status"] == "confirmed" and results["confirm"] == 200 and results["edit"] in (200, 409)
    assert d(inventory.ledger[0]["quantity"]) == d(final["lines"][0]["quantity"]) and stock(inventory, depot, "bolt") == 40 - d(final["lines"][0]["quantity"])


def test_the_database_rows_match_the_story(api, depot, inventory, ready, bolt_line, session_factory):
    draft = api.draft(ready["id"], [bolt_line(15)])
    inventory.post_modes = ["timeout_before"]
    api.confirm(draft["id"])
    with session_factory() as db:
        row = db.execute(text("SELECT status, posting_key, posting_attempts, inventory_operation_id FROM dispatches WHERE id = :id"), {"id": uuid.UUID(draft["id"])}).one()
    assert row.status == "posting" and row.posting_key == f"dispatch-{draft['id']}" and row.posting_attempts == 1 and row.inventory_operation_id is None
