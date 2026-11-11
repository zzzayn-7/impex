"""The printable Sales Invoice: an A4 PDF in a fixed, professional navy-and-white identity (independent of anyone's dashboard theme).

Built from the SAVED invoice only - its snapshots (seller, client, product names, negotiated unit prices), the amounts the backend calculated, the recorded payments - plus the
organization's branding (name, description, logo) read through the Organization Service. Nothing is recalculated, nothing is taken from the browser, and nothing is written:
building the PDF is a read-only operation. The same file is what Print opens and what Download saves, so they cannot differ.

Layout: company branding and the INVOICE title with its number; two equal light panels (BILLED TO, INVOICE META); a navy item table (# / ITEM DESCRIPTION / QUANTITY / RATE / PC / AMOUNT)
that repeats its header on every page and never splits a row; a compact subtotal / discount / tax breakdown when there is one; a full-width navy GRAND TOTAL bar (shown once, at the
end); paid / balance and the payments; TERMS & NOTES (only what is saved on the invoice); the authorized-signature line. DRAFT and VOID are stamped on every page; the red
CONFIDENTIAL stamp is a deployment setting (INVOICE_CONFIDENTIAL_STAMP, on by default); page numbers appear only when there is more than one page. Text is left uncompressed so the
document can be searched and tested; standard PDF fonts are used (no external service is called).
"""
import os
from dataclasses import dataclass
from decimal import Decimal
from io import BytesIO
from typing import List, Optional
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import CondPageBreak, Flowable, HRFlowable, Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.schemas import DISCLAIMER, InvoiceDetail

NAVY = colors.HexColor("#102B53")
BLUE = colors.HexColor("#2456A6")
PANEL = colors.HexColor("#F1F6FB")
ROW_ALT = colors.HexColor("#F7FAFD")
GRID = colors.HexColor("#D5DFEA")
GREY = colors.HexColor("#5B6B7F")
INK = colors.HexColor("#1B2A3C")
RED = colors.HexColor("#C0392B")

PAGE_W, PAGE_H = A4
MARGIN = 16 * mm
CONTENT = PAGE_W - 2 * MARGIN  # 178 mm
BASE = "Helvetica"
BOLD = "Helvetica-Bold"

SYMBOLS = {"PKR": "Rs.", "INR": "Rs.", "USD": "$", "EUR": "€", "GBP": "£"}  # the symbols the standard PDF fonts can draw; anything else is written as its code


@dataclass
class Branding:
    """What the organization looks like: its name, a one-line business description and its logo (image bytes, or None for the initials fallback)."""

    name: str = ""
    description: str = ""
    logo: Optional[bytes] = None


def confidential_stamp_enabled() -> bool:
    return os.getenv("INVOICE_CONFIDENTIAL_STAMP", "true").strip().lower() not in ("0", "false", "no", "off")


def payment_status(invoice: InvoiceDetail) -> str:
    """The status the records justify - never a default label."""
    if invoice.status == "draft":
        return "DRAFT"
    if invoice.status == "void":
        return "VOID"
    if invoice.status == "paid":
        return "PAID"
    if invoice.overdue:
        return "OVERDUE"
    return "PARTIALLY PAID" if invoice.status == "partially_paid" else "UNPAID"


def _plain(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


class _Money:
    """The saved amounts written exactly (grouped, never rounded). A document whose amounts are all whole numbers is written without decimals ("Rs. 120,000"); as soon as one
    amount needs them, every amount shows at least two so the columns stay consistent."""

    def __init__(self, currency: str, values: List[Decimal]):
        self.symbol = SYMBOLS.get(currency, currency)
        self.whole = all(v == v.to_integral_value() for v in values)

    def number(self, value: Decimal) -> str:
        if self.whole:
            return f"{value:,.0f}"
        whole, _, fraction = f"{value:,.4f}".partition(".")
        return f"{whole}.{fraction.rstrip('0').ljust(2, '0')}"

    def __call__(self, value: Decimal) -> str:
        sign = "-" if value < 0 else ""
        return f"{sign}{self.symbol} {self.number(abs(value))}"


class _Initials(Flowable):
    """The logo fallback: a clean navy square with the organization's initials."""

    def __init__(self, text: str, size: float):
        super().__init__()
        self.text, self.size = text, size
        self.width = self.height = size

    def draw(self):
        self.canv.setFillColor(NAVY)
        self.canv.roundRect(0, 0, self.size, self.size, 2.2 * mm, stroke=0, fill=1)
        self.canv.setFillColor(colors.white)
        self.canv.setFont(BOLD, self.size * 0.4)
        self.canv.drawCentredString(self.size / 2, self.size * 0.32, self.text)


def _initials(name: str) -> str:
    words = [w for w in "".join(c if c.isalnum() else " " for c in name).split() if w]
    if not words:
        return "?"
    return (words[0][0] + (words[1][0] if len(words) > 1 else (words[0][1] if len(words[0]) > 1 else ""))).upper()


def _logo(branding: Branding, name: str, box: float):
    """The uploaded logo at its own aspect ratio inside a square box - or the initials square when there is none (or it cannot be read)."""
    if branding.logo:
        try:
            width, height = ImageReader(BytesIO(branding.logo)).getSize()
            scale = min(box / width, box / height)
            return Image(BytesIO(branding.logo), width=width * scale, height=height * scale)
        except Exception:
            pass
    return _Initials(_initials(name), box)


def _style(name: str, **kw) -> ParagraphStyle:
    size = kw.pop("fontSize", 9)
    return ParagraphStyle(name, fontName=kw.pop("fontName", BASE), fontSize=size, leading=kw.pop("leading", None) or size * 1.3, textColor=kw.pop("textColor", INK), **kw)


def _terms_flowables(text: str) -> List[Paragraph]:
    """The saved notes as the panel's lines: a line starting with - * or a bullet becomes a bullet point, any other line a paragraph; blank lines are only spacing."""
    body = _style("terms", fontSize=8.5, leading=11.5)
    out: List[Paragraph] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line[0] in "-*•" and len(line) > 1:
            out.append(Paragraph(escape(line[1:].strip()), body, bulletText="•"))
        else:
            out.append(Paragraph(escape(line), body))
    return out


def build_pdf(invoice: InvoiceDetail, branding: Optional[Branding] = None, *, contact_person: Optional[str] = None, confidential: Optional[bool] = None) -> bytes:
    branding = branding or Branding()
    name = invoice.seller_name or branding.name or "Organization"
    show_stamp = confidential_stamp_enabled() if confidential is None else confidential
    number = invoice.number or "DRAFT"
    money = _Money(invoice.currency_code, [v for line in invoice.lines for v in (line.unit_price, line.line_subtotal, line.discount_amount, line.line_tax)]
                   + [invoice.subtotal, invoice.discount_total, invoice.tax_total, invoice.total, invoice.paid_total, invoice.outstanding] + [p.amount for p in invoice.payments])

    small = _style("small", fontSize=7.5, textColor=GREY)
    heading = _style("heading", fontName=BOLD, fontSize=8, textColor=BLUE)
    value = _style("value", fontSize=9.5, leading=12.5)

    out = BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=14 * mm, bottomMargin=18 * mm,
                            title=f"Invoice {number}", author=name, subject=f"Invoice {number} - {name}", pageCompression=0)
    story: list = []

    # ---- header: branding left, INVOICE and its number right -------------------------------------------------------------------------------
    brand_text = [Paragraph(escape(name), _style("org", fontName=BOLD, fontSize=17, leading=20, textColor=NAVY))]
    if branding.description.strip():
        brand_text.append(Paragraph(escape(branding.description.strip()[:160]), _style("sub", fontSize=9, leading=12, textColor=GREY)))
    left = Table([[_logo(branding, name, 17 * mm), brand_text]], colWidths=[22 * mm, CONTENT / 2 - 22 * mm])
    left.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    right = [Paragraph("INVOICE", _style("title", fontName=BOLD, fontSize=27, leading=30, textColor=NAVY, alignment=2)),
             Paragraph(f"#{escape(number)}" if invoice.number else "#DRAFT", _style("num", fontName=BOLD, fontSize=12, leading=15, textColor=BLUE, alignment=2)), Spacer(1, 13 * mm)]
    header = Table([[left, right]], colWidths=[CONTENT / 2, CONTENT / 2])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story += [header, HRFlowable(width="100%", thickness=1.6, color=NAVY, spaceBefore=1, spaceAfter=6 * mm)]

    # ---- BILLED TO | INVOICE META ------------------------------------------------------------------------------------------------------------
    billed = [Paragraph("BILLED TO", heading), Spacer(1, 2 * mm), Paragraph(f"<b>{escape(invoice.client_name or '')}</b>", _style("client", fontName=BOLD, fontSize=11.5, leading=14, textColor=NAVY))]
    if invoice.client_address:
        billed.append(Paragraph(f"<font color='#5B6B7F'>Address:</font> {escape(invoice.client_address).replace(chr(10), '<br/>')}", value))
    if contact_person:
        billed.append(Paragraph(f"<font color='#5B6B7F'>Contact Person:</font> {escape(contact_person)}", value))
    status_text = payment_status(invoice)
    status_color = "#C0392B" if status_text in ("OVERDUE", "VOID") else "#102B53"
    meta = [Paragraph("INVOICE META", heading), Spacer(1, 2 * mm),
            Paragraph(f"<font color='#5B6B7F'>Invoice Date:</font> <b>{invoice.invoice_date.strftime('%d %b %Y')}</b>", value),
            Paragraph(f"<font color='#5B6B7F'>Due Date:</font> {invoice.due_date.strftime('%d %b %Y')}", value),
            Paragraph(f"<font color='#5B6B7F'>Payment Status:</font> <b><font color='{status_color}'>{status_text}</font></b>", value),
            Paragraph(f"<font color='#5B6B7F'>Currency:</font> {escape(invoice.currency_code)}", value)]
    if invoice.delivery_list:
        meta.append(Paragraph(f"<font color='#5B6B7F'>Delivery List:</font> {escape(invoice.delivery_list.number)}", value))
    panels = Table([[billed, "", meta]], colWidths=[CONTENT / 2 - 2 * mm, 4 * mm, CONTENT / 2 - 2 * mm])
    panels.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PANEL), ("BACKGROUND", (2, 0), (2, 0), PANEL), ("LINEABOVE", (0, 0), (0, 0), 1.6, BLUE), ("LINEABOVE", (2, 0), (2, 0), 1.6, BLUE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LEFTPADDING", (1, 0), (1, 0), 0), ("RIGHTPADDING", (1, 0), (1, 0), 0),
    ]))
    story += [panels, Spacer(1, 7 * mm)]

    # ---- the item table ----------------------------------------------------------------------------------------------------------------------
    th = _style("th", fontName=BOLD, fontSize=8, textColor=colors.white)
    rows = [[Paragraph("#", _style("th0", fontName=BOLD, fontSize=8, textColor=colors.white, alignment=1)), Paragraph("ITEM DESCRIPTION", th),
             Paragraph("QUANTITY", _style("th2", fontName=BOLD, fontSize=8, textColor=colors.white, alignment=1)), Paragraph("RATE / PC", _style("th3", fontName=BOLD, fontSize=8, textColor=colors.white, alignment=2)),
             Paragraph("AMOUNT", _style("th4", fontName=BOLD, fontSize=8, textColor=colors.white, alignment=2))]]
    name_style = _style("item", fontName=BOLD, fontSize=9.5, leading=12)
    for index, line in enumerate(invoice.lines, start=1):
        detail = [Paragraph(escape(line.product_name), name_style)]
        extras = []
        if line.product_sku:
            extras.append(escape(line.product_sku))
        if line.discount_amount > 0:
            extras.append(f"Discount -{money(line.discount_amount)}")
        if line.tax_rate > 0:
            extras.append(f"Tax {_plain(line.tax_rate)}%{' ' + escape(line.tax_label) if line.tax_label else ''} {money(line.line_tax)}")
        if extras:
            detail.append(Paragraph(" &nbsp;&middot;&nbsp; ".join(extras), small))
        rows.append([Paragraph(f"{index:02d}", _style("n", fontSize=9, textColor=GREY, alignment=1)), detail,
                     Paragraph(f"{_plain(line.quantity)} {escape(line.unit.upper())}", _style("q", fontSize=9.5, alignment=1)),
                     Paragraph(money(line.unit_price), _style("r", fontSize=9.5, alignment=2)), Paragraph(f"<b>{money(line.line_subtotal)}</b>", _style("a", fontSize=9.5, alignment=2))])
    table = Table(rows, colWidths=[12 * mm, 82 * mm, 26 * mm, 29 * mm, 29 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("VALIGN", (0, 0), (-1, 0), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, 0), 7), ("BOTTOMPADDING", (0, 0), (-1, 0), 7),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW_ALT]), ("VALIGN", (0, 1), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 1), (-1, -1), 7), ("BOTTOMPADDING", (0, 1), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("LINEBELOW", (0, 1), (-1, -1), 0.4, GRID), ("LINEBELOW", (0, -1), (-1, -1), 0.8, NAVY),
    ]))
    story += [table, Spacer(1, 4 * mm)]

    # ---- the breakdown (only when there is one) and the GRAND TOTAL bar -----------------------------------------------------------------------
    closing: list = []
    breakdown = []
    if invoice.discount_total > 0 or invoice.tax_total > 0:
        breakdown.append(["Subtotal", money(invoice.subtotal)])
        if invoice.discount_total > 0:
            breakdown.append(["Discount", f"-{money(invoice.discount_total)}"])
        if invoice.tax_total > 0:
            breakdown.append(["Tax", money(invoice.tax_total)])
    if breakdown:
        bt = Table(breakdown, colWidths=[34 * mm, 44 * mm], hAlign="RIGHT")
        bt.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), BASE), ("FONTSIZE", (0, 0), (-1, -1), 9.5), ("TEXTCOLOR", (0, 0), (0, -1), GREY), ("TEXTCOLOR", (1, 0), (1, -1), INK),
                                ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
        closing += [bt, Spacer(1, 2 * mm)]
    bar = Table([[Paragraph("GRAND TOTAL", _style("gt", fontName=BOLD, fontSize=13, leading=16, textColor=colors.white)),
                  Paragraph(money(invoice.total), _style("gtv", fontName=BOLD, fontSize=17, leading=20, textColor=colors.white, alignment=2))]], colWidths=[CONTENT * 0.45, CONTENT * 0.55])
    bar.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), NAVY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                             ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10)]))
    closing.append(bar)
    # what has been paid and what is still owed: never hidden
    if invoice.status in ("issued", "partially_paid", "paid") or invoice.payments:
        owed = Table([["Amount paid", money(invoice.paid_total)], ["Balance due", money(invoice.outstanding)]], colWidths=[34 * mm, 44 * mm], hAlign="RIGHT")
        owed.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), BASE), ("FONTNAME", (0, 1), (-1, 1), BOLD), ("FONTSIZE", (0, 0), (-1, -1), 9.5), ("TEXTCOLOR", (0, 0), (0, -1), GREY),
                                  ("TEXTCOLOR", (1, 1), (1, 1), RED if invoice.outstanding > 0 and invoice.overdue else NAVY), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                                  ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
        closing += [Spacer(1, 2.5 * mm), owed]
    story += [CondPageBreak(60 * mm), KeepTogether(closing)]

    if invoice.payments:
        prow = [["DATE", "METHOD", "REFERENCE", "AMOUNT"]]
        for p in invoice.payments:
            label_text = p.method.replace("_", " ").title() + (" (reversal)" if p.kind == "reversal" else "")
            prow.append([p.payment_date.strftime("%d %b %Y"), label_text, p.reference or "", f"{'-' if p.kind == 'reversal' else ''}{money(p.amount)}"])
        pt = Table(prow, colWidths=[30 * mm, 50 * mm, 52 * mm, 46 * mm], repeatRows=1)
        pt.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, 0), BOLD), ("FONTSIZE", (0, 0), (-1, -1), 8), ("TEXTCOLOR", (0, 0), (-1, 0), BLUE), ("BACKGROUND", (0, 0), (-1, 0), PANEL),
                                ("ALIGN", (3, 0), (3, -1), "RIGHT"), ("LINEBELOW", (0, 1), (-1, -1), 0.3, GRID), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        story += [Spacer(1, 5 * mm), Paragraph("PAYMENTS RECEIVED", heading), Spacer(1, 1.5 * mm), pt]

    # ---- TERMS & NOTES: only what is saved on the invoice ----------------------------------------------------------------------------------------
    terms = _terms_flowables(invoice.notes) if invoice.notes else []
    if invoice.status == "void":
        terms.insert(0, Paragraph(f"<b>This invoice has been voided{': ' + escape(invoice.void_reason) if invoice.void_reason else ''}.</b>", _style("void", fontSize=8.5, leading=11.5, textColor=RED)))
    if terms:
        story.append(Spacer(1, 7 * mm))
        panel_rows = [[Paragraph("TERMS &amp; NOTES", heading)]] + [[t] for t in terms]
        tp = Table(panel_rows, colWidths=[CONTENT])
        tp.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("LINEABOVE", (0, 0), (-1, 0), 1.6, BLUE), ("LEFTPADDING", (0, 0), (-1, -1), 11), ("RIGHTPADDING", (0, 0), (-1, -1), 11),
                                ("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5), ("TOPPADDING", (0, 0), (-1, 0), 9), ("BOTTOMPADDING", (0, -1), (-1, -1), 9)]))
        story.append(tp)

    # ---- the authorized signature (blank, for a physical signature) --------------------------------------------------------------------------
    sign = Table([[""], [Paragraph("Authorized Signature", _style("sig", fontName=BOLD, fontSize=9.5, textColor=NAVY, alignment=1))], [Paragraph(escape(name), _style("signame", fontSize=9, textColor=GREY, alignment=1))]],
                 colWidths=[66 * mm], rowHeights=[22 * mm, None, None], hAlign="RIGHT")
    sign.setStyle(TableStyle([("LINEABOVE", (0, 1), (0, 1), 0.9, NAVY), ("TOPPADDING", (0, 1), (-1, 1), 3), ("TOPPADDING", (0, 0), (-1, 0), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
    story += [Spacer(1, 8 * mm), KeepTogether([sign]), Spacer(1, 6 * mm), Paragraph(escape(DISCLAIMER), _style("disc", fontSize=6.8, leading=8.5, textColor=GREY, alignment=1))]

    def decorate(c: pdfcanvas.Canvas, page: int, pages: int) -> None:
        c.saveState()
        if invoice.status in ("draft", "void"):  # on EVERY page, so no page can be mistaken for a valid invoice
            c.setFillColor(RED if invoice.status == "void" else GREY)
            c.setFillAlpha(0.11)
            c.setFont(BOLD, 120)
            c.translate(PAGE_W / 2, PAGE_H / 2)
            c.rotate(40)
            c.drawCentredString(0, -40, "VOID" if invoice.status == "void" else "DRAFT")
        c.restoreState()
        if page == 1 and show_stamp:
            c.saveState()
            c.translate(PAGE_W - MARGIN - 33 * mm, PAGE_H - 14 * mm - 25.5 * mm)
            c.rotate(7)
            c.setStrokeColor(RED)
            c.setFillColor(RED)
            c.setStrokeAlpha(0.85)
            c.setFillAlpha(0.85)
            c.setLineWidth(1.4)
            c.roundRect(-25 * mm, -4.2 * mm, 50 * mm, 8.4 * mm, 1.5 * mm, stroke=1, fill=0)
            c.setFont(BOLD, 10.5)
            c.drawCentredString(0, -1.3 * mm, "CONFIDENTIAL")
            c.restoreState()
        if page > 1:
            c.setFont(BASE, 7.5)
            c.setFillColor(GREY)
            c.drawString(MARGIN, PAGE_H - 9 * mm, f"INVOICE #{number}  -  {name}")
            c.setStrokeColor(GRID)
            c.line(MARGIN, PAGE_H - 10.5 * mm, PAGE_W - MARGIN, PAGE_H - 10.5 * mm)
        if pages > 1:
            c.setFont(BASE, 7.5)
            c.setFillColor(GREY)
            c.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Page {page} of {pages}")

    class _Numbered(pdfcanvas.Canvas):
        """Draws the page furniture once the page count is known (page numbers only when there is more than one page)."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._pages: list = []

        def showPage(self):
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for number_, state in enumerate(self._pages, start=1):
                self.__dict__.update(state)
                decorate(self, number_, total)
                super().showPage()
            super().save()

    doc.build(story, canvasmaker=_Numbered)
    return out.getvalue()
