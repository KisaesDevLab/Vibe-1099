# Vibe 1099 render sidecar — WeasyPrint + Jinja2 (port 8212)
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libffi8 libjpeg62-turbo \
    libopenjp2-7 libcairo2 fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates/ templates/
COPY css/ css/
COPY xsd/ xsd/

EXPOSE 8212
# Drop root: WeasyPrint/lxml/pypdf parse untrusted bytes, so run the sidecar as an
# unprivileged user to contain any parser RCE (least privilege — Pub 4557).
RUN useradd --system --uid 1001 --no-create-home render && chown -R render:render /app
USER render
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8212/health')" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:8212", "--workers", "2", "--timeout", "120", "app:app"]
