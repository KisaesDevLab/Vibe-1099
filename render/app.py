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
import zipfile

from flask import Flask, jsonify, request
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pypdf import PdfReader, PdfWriter
from weasyprint import HTML, default_url_fetcher

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


def safe_url_fetcher(url):
    """Restrict WeasyPrint resource loading to inline data: URIs and the local
    CSS directory. Blocks file:// and http(s):// so attacker-controlled values
    rendered as <img src> (e.g. a W-9 signature image) cannot trigger SSRF or
    local-file disclosure."""
    if url.startswith("data:"):
        return default_url_fetcher(url)
    if url.startswith("file://"):
        # only permit files inside the bundled CSS dir (external stylesheets).
        # Keep the absolute path as-is (WeasyPrint emits file:///app/css/base.css).
        path = os.path.realpath(url[len("file://"):])
        css_real = os.path.realpath(CSS_DIR)
        # base_url resolves relative hrefs against CSS_DIR; allow those only
        if path.startswith(css_real + os.sep) or os.path.dirname(path) == css_real:
            return default_url_fetcher(url)
    raise ValueError(f"blocked resource URL scheme: {url[:32]}")


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
        pdf = HTML(string=html, base_url=CSS_DIR, url_fetcher=safe_url_fetcher).write_pdf()
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


@app.post("/zip")
def zip_files():
    """Bundle named files into a single zip. {files: [{name, pdf(base64)}]} -> {zip: base64}."""
    body = request.get_json(force=True)
    files = body.get("files", [])
    if not files:
        return jsonify(error="no files provided"), 400
    out = io.BytesIO()
    seen = {}
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in files:
                raw = (f.get("name") or "file.pdf").strip() or "file.pdf"
                # keep the entry flat + filename-safe; de-dupe collisions
                name = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(raw))
                if name in seen:
                    seen[name] += 1
                    stem, ext = os.path.splitext(name)
                    name = f"{stem}_{seen[name]}{ext}"
                else:
                    seen[name] = 0
                zf.writestr(name, base64.b64decode(f.get("pdf", "")))
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"zip failed: {exc}"), 500
    return jsonify(zip=base64.b64encode(out.getvalue()).decode(), count=len(files))


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

    # hardened parser: no external entity resolution, no DTD loading, no network,
    # bounded tree — prevents XXE / entity-expansion via posted XML
    safe_parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        huge_tree=False,
    )
    try:
        schema = etree.XMLSchema(etree.parse(xsd_path, safe_parser))
        doc = etree.fromstring(xml.encode(), safe_parser)
        valid = schema.validate(doc)
        errors = [str(e) for e in schema.error_log]
        return jsonify(valid=valid, errors=errors, skipped=False)
    except Exception as exc:  # noqa: BLE001
        return jsonify(valid=False, errors=[str(exc)], skipped=False), 422


if __name__ == "__main__":
    # Bind to loopback by default; the appliance reaches the sidecar over the
    # internal Docker network. Set RENDER_BIND=0.0.0.0 only when that is required
    # and the port is NOT published to the host / public network.
    app.run(host=os.environ.get("RENDER_BIND", "127.0.0.1"), port=int(os.environ.get("PORT", "8212")))
