"""
Vibe 1099 render sidecar — WeasyPrint HTTP micro-service (port 8212).

POST /render        {template, data}          -> PDF bytes
POST /merge         {pdfs: [base64, ...]}     -> {pdf: base64, pageCount}
POST /validate-xml  {xml, taxYear}            -> {valid, errors[], skipped}
GET  /health                                  -> {ok: true}

Templates: Jinja2 under ./templates with external CSS under ./css
(convention reused from the Vibe T&B invoice pattern). No network assets —
fonts embedded from system font dir, print-safe CSS only.
"""
import base64
import io
import os
import re

from flask import Flask, jsonify, request
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pypdf import PdfReader, PdfWriter
from weasyprint import HTML

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
CSS_DIR = os.path.join(BASE_DIR, "css")
XSD_DIR = os.path.join(BASE_DIR, "xsd")

app = Flask(__name__)

jinja = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    undefined=StrictUndefined,
    autoescape=True,
)


def fmt_money(cents):
    """integer cents -> 1,234.56 (blank when zero/None)"""
    if cents in (None, 0, ""):
        return ""
    cents = int(cents)
    neg = cents < 0
    cents = abs(cents)
    return f"{'-' if neg else ''}{cents // 100:,}.{cents % 100:02d}"


jinja.filters["money"] = fmt_money

ALLOWED_TEMPLATE = re.compile(r"^[a-z0-9_]+\.html$")


@app.get("/health")
def health():
    return jsonify(ok=True, service="vibe1099-render")


@app.post("/render")
def render_pdf():
    body = request.get_json(force=True)
    template_name = body.get("template", "")
    data = body.get("data", {})
    if not ALLOWED_TEMPLATE.match(template_name):
        return jsonify(error=f"invalid template name: {template_name}"), 400
    try:
        template = jinja.get_template(template_name)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"template not found: {exc}"), 404
    try:
        html = template.render(**data)
        pdf = HTML(string=html, base_url=CSS_DIR).write_pdf()
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"render failed: {exc}"), 500
    return app.response_class(pdf, mimetype="application/pdf")


@app.post("/merge")
def merge_pdfs():
    body = request.get_json(force=True)
    pdfs = body.get("pdfs", [])
    if not pdfs:
        return jsonify(error="no pdfs provided"), 400
    writer = PdfWriter()
    page_count = 0
    try:
        for b64 in pdfs:
            reader = PdfReader(io.BytesIO(base64.b64decode(b64)))
            for page in reader.pages:
                writer.add_page(page)
                page_count += 1
        out = io.BytesIO()
        writer.write(out)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"merge failed: {exc}"), 500
    return jsonify(pdf=base64.b64encode(out.getvalue()).decode(), pageCount=page_count)


@app.post("/validate-xml")
def validate_xml():
    """XSD validation pass before IRIS transmit. Skips gracefully when no XSD
    is bundled for the tax year (schema-version pin per tax year)."""
    body = request.get_json(force=True)
    xml = body.get("xml", "")
    tax_year = str(body.get("taxYear", ""))
    xsd_path = os.path.join(XSD_DIR, tax_year, "IRTransmission.xsd")
    if not os.path.exists(xsd_path):
        return jsonify(valid=True, errors=[], skipped=True,
                       note=f"no bundled XSD for TY{tax_year}; structural checks only")
    from lxml import etree  # lazy import

    try:
        schema = etree.XMLSchema(etree.parse(xsd_path))
        doc = etree.fromstring(xml.encode())
        valid = schema.validate(doc)
        errors = [str(e) for e in schema.error_log]
        return jsonify(valid=valid, errors=errors, skipped=False)
    except Exception as exc:  # noqa: BLE001
        return jsonify(valid=False, errors=[str(exc)], skipped=False), 422


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8212")))
