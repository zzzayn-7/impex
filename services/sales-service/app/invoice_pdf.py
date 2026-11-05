"""A downloadable PDF of one invoice.

Built from the SAVED invoice only (its snapshots, the amounts the backend calculated, the recorded payments) - nothing is
recalculated or taken from the browser. The text streams are left uncompressed so the document can be searched and tested.
Standard PDF fonts are used (Latin characters); no external service is called.
"""
from decimal import Decimal
from io import BytesIO
from typing import List
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.schemas import DISCLAIMER, InvoiceDetail

STATUS_LABELS = {"draft": "DRAFT", "issued": "ISSUED", "partially_paid": "PARTIALLY PAID", "paid": "PAID", "void": "VOID"}


def _money(value: Decimal) -> str:
    """The stored amount, exactly: grouped, at least 2 decimals, up to 4 when the amount needs them. Never rounded (same as the portal)."""
    whole, _, fraction = f"{value:,.4f}".partition(".")
    return f"{whole}.{fraction.rstrip('0').ljust(2, '0')}"


def _plain(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def build_pdf(invoice: InvoiceDetail) -> bytes:
    styles = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=10, textColor=colors.HexColor("#444444"))
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=9, leading=12)
    right = ParagraphStyle("right", parent=body, alignment=2)
    title = ParagraphStyle("title", parent=styles["Title"], fontSize=22, alignment=0, spaceAfter=2)
    cur = invoice.currency_code

    out = BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"Invoice {invoice.number or 'DRAFT'}", author=invoice.seller_name or "Impex", pageCompression=0)
    story: List = []
    story.append(Paragraph("INVOICE" + (f" {escape(invoice.number)}" if invoice.number else " (draft)"), title))
    story.append(Paragraph(f"Status: {STATUS_LABELS[invoice.status]} &nbsp;&middot;&nbsp; Currency: {escape(cur)}", small))
    story.append(Spacer(1, 6 * mm))

    parties = Table(
        [[Paragraph(f"<b>From</b><br/>{escape(invoice.seller_name or '')}", body),
          Paragraph("<b>Bill to</b><br/>" + escape(invoice.client_name or "") + ("<br/>" + escape(invoice.client_address).replace("\n", "<br/>") if invoice.client_address else ""), body),
          Paragraph(f"<b>Invoice date</b> {invoice.invoice_date}<br/><b>Due date</b> {invoice.due_date}"
                    + (f"<br/><b>Delivery list</b> {escape(invoice.delivery_list.number)}" if invoice.delivery_list else ""), body)]],
        colWidths=[55 * mm, 60 * mm, 61 * mm],
    )
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story += [parties, Spacer(1, 6 * mm)]

    rows = [["Description", "Qty", "Unit price", "Discount", "Tax", "Total"]]
    for line in invoice.lines:
        tax = f"{_plain(line.tax_rate)}%" + (f" {line.tax_label}" if line.tax_label else "") if line.tax_rate > 0 else "-"
        rows.append([
            Paragraph(f"{escape(line.product_name)}<br/><font size='7' color='#666666'>{escape(line.product_sku)}</font>", body),
            f"{_plain(line.quantity)} {line.unit}", _money(line.unit_price), _money(line.discount_amount) if line.discount_amount > 0 else "-", escape(tax), _money(line.line_total),
        ])
    table = Table(rows, colWidths=[62 * mm, 22 * mm, 24 * mm, 22 * mm, 24 * mm, 22 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")), ("FONTSIZE", (0, 0), (-1, -1), 8), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cccccc")),
    ]))
    story += [table, Spacer(1, 4 * mm)]

    totals = [["Subtotal", f"{_money(invoice.subtotal)} {cur}"], ["Discount", f"-{_money(invoice.discount_total)} {cur}"], ["Tax", f"{_money(invoice.tax_total)} {cur}"],
              ["Total", f"{_money(invoice.total)} {cur}"], ["Paid", f"{_money(invoice.paid_total)} {cur}"], ["Outstanding", f"{_money(invoice.outstanding)} {cur}"]]
    t = Table(totals, colWidths=[30 * mm, 42 * mm], hAlign="RIGHT")
    t.setStyle(TableStyle([("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTSIZE", (0, 0), (-1, -1), 9), ("FONTNAME", (0, 3), (-1, 3), "Helvetica-Bold"),
                           ("FONTNAME", (0, 5), (-1, 5), "Helvetica-Bold"), ("LINEABOVE", (0, 3), (-1, 3), 0.5, colors.black)]))
    story += [t, Spacer(1, 6 * mm)]

    if invoice.payments:
        story.append(Paragraph("<b>Payments</b>", body))
        prow = [["Date", "Method", "Reference", "Amount"]]
        for p in invoice.payments:
            sign = "-" if p.kind == "reversal" else ""
            label = p.method.replace("_", " ") + (" (reversal)" if p.kind == "reversal" else "")
            prow.append([str(p.payment_date), label, escape(p.reference or ""), f"{sign}{_money(p.amount)} {cur}"])
        pt = Table(prow, colWidths=[30 * mm, 50 * mm, 52 * mm, 40 * mm], repeatRows=1)
        pt.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")), ("ALIGN", (3, 0), (3, -1), "RIGHT")]))
        story += [pt, Spacer(1, 4 * mm)]
    if invoice.notes:
        story += [Paragraph("<b>Notes</b><br/>" + escape(invoice.notes).replace("\n", "<br/>"), body), Spacer(1, 4 * mm)]
    if invoice.status == "void":
        story.append(Paragraph(f"<b>VOID</b>{' - ' + escape(invoice.void_reason) if invoice.void_reason else ''}", body))
    story.append(Paragraph(escape(DISCLAIMER), small))
    doc.build(story)
    return out.getvalue()
