# Bundled IRIS XSD schemas

Place the IRS-published IRIS A2A schema package for each supported tax year here:

```
xsd/2025/IRTransmission.xsd
xsd/2026/IRTransmission.xsd
```

The schema version is pinned per tax year (`IRIS_SCHEMA_VERSIONS` in
`packages/core/src/iris/xml.ts`). When an XSD is present, every transmission
gets a full lxml validation pass via `POST /validate-xml` before transmit;
when absent, structural registry-driven checks still run and validation is
marked `skipped`.

Schemas are distributed by the IRS to enrolled A2A transmitters and are not
committed to this repository.
