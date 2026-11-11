"""The printable Sales Invoice: branding, panels, the item table, the grand total, terms, signature, pagination, statuses - and that producing it changes nothing."""
import re
from io import BytesIO

import pytest
from PIL import Image
from sqlalchemy import text

from conftest import INVOICES, bill
from test_invoices import depot, world  # noqa: F401  (the fixtures of the invoice tests)


def png(size=(300, 150)) -> bytes:
    out = BytesIO()
    Image.new("RGB", size, (36, 86, 166)).save(out, "PNG")
    return out.getvalue()


def pdf_of(api, invoice_id, **params):
    response = api.client.get(f"{INVOICES}/{invoice_id}/pdf", params=params, headers=api.headers)
    assert response.status_code == 200, response.text
    return response


def pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type /Page\b(?!s)", pdf))


@pytest.fixture
def issued(api, depot, world):  # noqa: F811
    return api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "2.50", discount_amount="1", tax_rate="10", tax_label="VAT")], notes="- Check goods on delivery.\n- Pay within 14 days.\nThank you")


def test_the_header_names_the_organization_with_its_description_and_the_invoice_number(api, two_orgs, directory, issued):
    directory.descriptions[two_orgs["alpha_id"]] = "Hardware Trading & Distribution"
    pdf = pdf_of(api, issued["id"]).content
    for expected in (b"Alpha Trading", b"Hardware Trading &amp; Distribution".replace(b"&amp;", b"&"), b"INVOICE", b"#INV-000001"):
        assert expected in pdf, expected
    assert b"Tawqqal" not in pdf and b"RIZVIZ" not in pdf  # nothing of the reference sample is hardcoded


def test_an_uploaded_logo_is_fetched_through_the_secured_endpoint_and_drawn_and_without_one_the_initials_show(api, two_orgs, directory, issued):
    without = pdf_of(api, issued["id"]).content
    assert b"/Subtype /Image" not in without and b"AT" in without  # the initials of "Alpha Trading"
    directory.logos[two_orgs["alpha_id"]] = png()
    with_logo = pdf_of(api, issued["id"]).content
    assert b"/Subtype /Image" in with_logo


def test_only_the_callers_own_logo_is_used(api, two_orgs, directory, issued):
    directory.logos[two_orgs["beta_id"]] = png()  # another organization's logo
    assert b"/Subtype /Image" not in pdf_of(api, issued["id"]).content


def test_an_unreadable_logo_never_stops_the_invoice(api, two_orgs, directory, issued):
    directory.logos[two_orgs["alpha_id"]] = b"this is not an image"
    assert pdf_of(api, issued["id"]).status_code == 200


def test_billed_to_comes_from_the_invoice_and_the_clients_own_contact_and_nothing_is_invented(api, depot, world):  # noqa: F811
    noone = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 1, "2")])
    pdf = pdf_of(api, noone["id"]).content
    assert b"BILLED TO" in pdf and b"Acme Ltd" in pdf and b"1 Main St" in pdf and b"Berlin" in pdf
    assert b"Contact Person" not in pdf  # none stored: none shown
    other = api.new_client("Beta Shop", contact_person="Mr. Ali Raza")
    delivery_list = api.new_list(other["id"])
    api.add(delivery_list["id"], depot["bolt"], 2)
    dispatch = api.confirmed_dispatch(depot, api.status(delivery_list["id"], "ready").json(), [("bolt", 2)])
    inv = api.issued_invoice(other["id"], [bill(dispatch, depot["bolt"], 2, "2")])
    assert b"Contact Person" in pdf_of(api, inv["id"]).content and b"Mr. Ali Raza" in pdf_of(api, inv["id"]).content


def test_invoice_meta_shows_the_real_date_and_a_status_the_records_justify(api, issued):
    pdf = pdf_of(api, issued["id"]).content
    assert b"INVOICE META" in pdf and b"Invoice Date" in pdf and b"Due Date" in pdf and b"UNPAID" in pdf and b"PENDING" not in pdf
    api.pay(issued["id"], "10")
    assert b"PARTIALLY PAID" in pdf_of(api, issued["id"]).content
    api.pay(issued["id"], "16.40")
    assert b"PAID" in pdf_of(api, issued["id"]).content and b"UNPAID" not in pdf_of(api, issued["id"]).content


def test_an_overdue_invoice_says_overdue(api, depot, world):  # noqa: F811
    old = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 1, "2")], invoice_date="2020-01-01", due_date="2020-01-15")
    assert old["overdue"] is True and b"OVERDUE" in pdf_of(api, old["id"]).content


def test_the_item_table_has_the_five_columns_numbered_rows_the_unit_and_the_negotiated_price(api, issued):
    pdf = pdf_of(api, issued["id"]).content
    for heading in (b"ITEM DESCRIPTION", b"QUANTITY", b"RATE / PC", b"AMOUNT"):
        assert heading in pdf, heading
    for cell in (b"01", b"Steel bolt", b"10 PCS", b"$ 2.50", b"$ 25.00"):
        assert cell in pdf, cell


def test_discounts_taxes_totals_and_the_balance_are_the_saved_figures(api, issued):
    api.pay(issued["id"], "6.40")
    pdf = pdf_of(api, issued["id"]).content
    assert (issued["subtotal"], issued["discount_total"], issued["tax_total"], issued["total"]) == ("25.0000", "1.0000", "2.4000", "26.4000")
    for expected in (b"Subtotal", b"$ 25.00", b"Discount", b"-$ 1.00", b"Tax", b"$ 2.40", b"GRAND TOTAL", b"$ 26.40", b"Amount paid", b"$ 6.40", b"Balance due", b"$ 20.00"):
        assert expected in pdf, expected
    assert pdf.count(b"GRAND TOTAL") == 1


def test_a_whole_number_invoice_is_written_without_decimals_and_a_fractional_one_keeps_them_exact(api, depot, world):  # noqa: F811
    whole = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 10, "120000")], currency="PKR")
    pdf = pdf_of(api, whole["id"]).content
    assert b"Rs. 120,000" in pdf and b"Rs. 1,200,000" in pdf and b"120,000.00" not in pdf
    fractional = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["flour"], "0.5", "3.3333")], currency="PKR")
    assert b"Rs. 3.3333" in pdf_of(api, fractional["id"]).content


def test_terms_and_notes_are_only_what_was_saved_with_bullets(api, issued, world, depot):  # noqa: F811
    pdf = pdf_of(api, issued["id"]).content
    assert b"TERMS &amp; NOTES" in pdf or b"TERMS & NOTES" in pdf
    assert b"Check goods on delivery." in pdf and b"Pay within 14 days." in pdf and b"Thank you" in pdf
    bare = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["flour"], 1, "2")])
    assert b"TERMS" not in pdf_of(api, bare["id"]).content  # no notes: the section is hidden, no terms are invented


def test_the_authorized_signature_block_is_blank_with_the_organization_name(api, issued):
    pdf = pdf_of(api, issued["id"]).content
    assert b"Authorized Signature" in pdf and pdf.count(b"Alpha Trading") >= 2


def test_the_confidential_stamp_is_a_setting(api, issued, monkeypatch):
    assert b"CONFIDENTIAL" in pdf_of(api, issued["id"]).content
    monkeypatch.setenv("INVOICE_CONFIDENTIAL_STAMP", "false")
    assert b"CONFIDENTIAL" not in pdf_of(api, issued["id"]).content


def test_a_draft_has_no_number_and_a_draft_mark_and_a_void_invoice_says_void_with_its_reason(api, depot, world):  # noqa: F811
    draft = api.draft_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 3, "2")])
    pdf = pdf_of(api, draft["id"]).content
    assert b"#DRAFT" in pdf and b"DRAFT" in pdf and b"INV-0" not in pdf
    api.void(draft["id"], reason="Entered in error")
    voided = pdf_of(api, draft["id"]).content
    assert voided.count(b"VOID") >= 2 and b"Entered in error" in voided


def test_print_opens_it_inline_and_download_saves_the_same_document(api, issued):
    download = pdf_of(api, issued["id"])
    inline = pdf_of(api, issued["id"], inline="true")
    assert download.headers["content-disposition"] == 'attachment; filename="INV-000001.pdf"'
    assert inline.headers["content-disposition"] == 'inline; filename="INV-000001.pdf"'
    streams = lambda b: re.findall(rb"stream\n(.*?)endstream", b, re.S)  # noqa: E731  (the pages; only the file's creation time and id differ between two runs)
    assert streams(download.content) == streams(inline.content)  # one renderer: they cannot differ


def test_a_long_invoice_paginates_with_the_header_repeated_page_numbers_and_one_grand_total(api, two_orgs, inventory, world):  # noqa: F811
    org = two_orgs["alpha_id"]
    shop = {f"p{i}": inventory.add_product(org, f"LONG-{i:03d}", f"Network accessory number {i} with a rather long descriptive hardware name", "pcs") for i in range(45)}
    delivery_list = api.new_list(world["client"]["id"])
    for pid in shop.values():
        inventory.set_stock(pid, 10)
        api.add(delivery_list["id"], pid, 1)
    ready = api.status(delivery_list["id"], "ready").json()
    dispatch = api.confirmed_dispatch(shop, ready, [(key, 1) for key in shop])
    inv = api.issued_invoice(world["client"]["id"], [bill(dispatch, pid, 1, str(100 + i)) for i, pid in enumerate(shop.values())])
    pdf = pdf_of(api, inv["id"]).content
    count = pages(pdf)
    assert count >= 2
    assert pdf.count(b"ITEM DESCRIPTION") == count  # the table header is repeated on every page
    assert all(f"Page {n} of {count}".encode() in pdf for n in range(1, count + 1)) and pdf.count(b"GRAND TOTAL") == 1
    assert pdf.index(b"LONG-000") < pdf.index(b"LONG-044") < pdf.index(b"GRAND TOTAL") < pdf.index(b"Authorized Signature")  # items in order, then the total, then the signature
    assert pdf.count(b"INV-000001") >= count  # the running header names the invoice on the continuation pages


def test_a_one_page_invoice_has_no_page_numbers(api, issued):
    assert b"Page 1 of" not in pdf_of(api, issued["id"]).content


def test_names_and_notes_with_markup_cannot_break_the_layout(api, depot, world):  # noqa: F811
    inv = api.issued_invoice(world["client"]["id"], [bill(world["dispatch"], depot["bolt"], 1, "2")], notes="<b>bold</b> & <i>more</i>\n- <script>x</script>")
    assert pdf_of(api, inv["id"]).status_code == 200


def test_printing_changes_nothing(api, issued, session_factory):
    def snapshot():
        with session_factory() as db:
            return [db.execute(text(f"SELECT count(*), md5(string_agg(t::text, ',' ORDER BY t.id::text)) FROM {t} t")).one() for t in ("invoices", "invoice_lines")] + [db.execute(text("SELECT count(*) FROM invoice_payments")).scalar()]
    before = snapshot()
    for _ in range(3):
        pdf_of(api, issued["id"])
        pdf_of(api, issued["id"], inline="true")
    assert snapshot() == before
    assert api.client.get(f"{INVOICES}/{issued['id']}", headers=api.headers).json()["total"] == "26.4000"


def test_another_organizations_invoice_cannot_be_printed(two_orgs, issued):
    assert two_orgs["beta"].client.get(f"{INVOICES}/{issued['id']}/pdf", headers=two_orgs["beta"].headers).status_code == 404
    assert two_orgs["alpha"].client.get(f"{INVOICES}/{issued['id']}/pdf").status_code == 401


def test_the_text_is_selectable_and_searchable(api, issued):
    pdf = pdf_of(api, issued["id"]).content
    assert b"Steel bolt" in pdf and b"Acme Ltd" in pdf  # plain text objects, not pictures of text
