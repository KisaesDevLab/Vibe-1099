# Load test plan (Phase 12)

Targets: 5,000 form records · 500-form batch render < 60 s · 1,000-record IRIS batch.

## Data generation

```bash
# 5k records across 10 payers (uses the API; run against a scratch database)
npx tsx scripts/load-seed.ts --payers 10 --recipients 2000 --forms 5000
```

(`load-seed.ts` variant of the demo seed — generate synthetic TINs in the 400-xx range, never
real ones.)

## Scenarios

1. **Grid + summary latency:** `GET /api/forms?payerId=…&taxYear=…` and
   `GET /api/forms/summary/...` under 5k rows — expect < 500 ms.
2. **Batch render:** build one 500-form batch; watch Settings → Queues; assert
   `built` within 60 s (10 chunks × 50 across 4-way worker concurrency; render sidecar 2 workers —
   scale gunicorn `--workers` and worker `concurrency` together if over).
3. **IRIS 1,000-record batch:** queue 1,000 records for one payer against the mock
   (`IRIS_MOCK_BASE_URL`); assert compose < 10 s, XML < 100 MB, transmit + ack apply < 2 min.
4. **Portal burst:** 50 concurrent recipient-portal PDF downloads (each renders live) —
   watch render sidecar saturation; PDFs are also cacheable in blobs if this becomes a bottleneck.

Record results in STATE.md before each season.
