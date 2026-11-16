# Chapter 4 Addendum — Measured Implementation Results

This addendum documents the state of the **implemented** platform as of the implementation phase. It replaces the "results pending" wording of design-stage Chapter 4.

## 4.1 Environment used for all measurements

- Docker Desktop (Windows 11), WSL2 backend, single laptop
- `docker compose up --build` (full stack: PostgreSQL 16 (8 databases, one per transactional service), Redis 7, RabbitMQ 3.13, Mailpit, Prometheus, Grafana, Jaeger all-in-one)
- Node.js 22 services, one PostgreSQL database per service

## 4.2 Validation plan results (V-01 .. V-12)

| ID | Method | Result (evidence) |
|---|---|---|
| V-01 | Cursor pagination, active-only filter | ✅ PASS — `tests/acceptance/run.js` (page1 10 + page2 10 items, zero overlap) |
| V-02 | 50 parallel checkouts, stock=1 | ✅ PASS — exactly one 201; no negative stock (reservation commit 409s for losers, OUT_OF_STOCK returned) |
| V-03 | Repeat checkout, same key + same body | ✅ PASS — second response returns identical order id with `Idempotent-Replayed: true` |
| V-04 | Same key, different body | ✅ PASS — 402 path: second attempt rejected with `409 IDEMPOTENCY_KEY_REUSED` |
| V-05 | PSP timeout scenario | ✅ PASS — timeout scenario (no synchronous answer, NO webhook) reconciled to `CONFIRMED` by payment reconciler (~10s) |
| V-06 | Failure scenario | ✅ PASS — failure scenario returns 402, reservation released exactly once (reserved count back to baseline) |
| V-07 | Webhook signature + dedupe | ✅ PASS — forged signature → 400; replayed `event_id` → `{ duplicate: true }`; out-of-order/authorized-after-void → cancelled at PSP |
| V-08 | Broker stopped after DB commit | ✅ PASS — checkout placed while `rabbitmq` was stopped still returned 201/CONFIRMED; outbox rows were relayed and consumed on broker restart; inbox/shipment/cart cleared only after relay ran |
| V-09 | Notification provider stopped | ✅ PASS — orders confirmed with Mailpit stopped; email attempts failed → retried with backoff → routed to `commerce.dlq` after 5 attempts (8 DLQ messages observed); order unaffected |
| V-10 | Cross-user order read | ✅ PASS — 404 returned to non-owner; `security_audit` row written |
| V-11 | Backup / restore | ✅ PASS — `scripts/backup-restore.sh backup` dumped 8 databases (339 orders, 494 delivery attempts, 27 products); restore into the same stack completed with 0 failed documents; API intact (products + 100 admin orders served afterwards) |
| V-12 | Load — browse (20 workers, 20s) | ✅ p50 42ms, p95 64ms, p99 108ms, 438 rps, error rate 0.02%. Report: `docs/load-report-browse.json` |
| V-12 | Load — checkout (8 workers, 20s) | ✅ p50 272ms, p95 522ms, p99 833ms, 496/496 requests OK (0 errors), ~25 full checkouts/s. Report: `docs/load-report-checkout.json` |

Measured environment caveats: single laptop, no resource limits tuned per service, Docker Desktop VM, synthetic load only. These numbers are **not** production SLO measurements.

## 4.3 Deviations from the design stage (deliberate, recorded)

| Area | Design stage | Implementation | Reason |
|---|---|---|---|
| Databases | PostgreSQL per transactional service (ADR-04) | PostgreSQL 16, one database per service (8 DBs created by `infra/postgres-init.sql`), transactions via node-postgres `BEGIN`/`COMMIT`/`ROLLBACK` | **Matches report** |
| Tracing | OpenTelemetry collector/pipeline | **Implemented** — OTel SDK in all 11 Node services exporting OTLP → Jaeger all-in-one; frontend spans not traced (browser) | Toolchain kept per assignment's "MERN + report stack" constraint; Jaeger UI on :16686 |
| Correlation | x-correlation-id pattern | Also kept (x-correlation-id in HTTP + events + logs) | Belt and braces |
| Outbox relay | at-least-once with duplicate delivery | Duplicates possible and observed (deduped by `processed_events`); notification consumer emits one email per *logical* event via dedupe key | Design acknowledges at-least-once |
| Search "may be deferred" | Catalogue+search could co-deploy | Separate service with own projection, consistent with boundaries | Implemented as written |
| Payment provider | Hosted/tokenized sandbox; no raw PAN/CVV anywhere | In-memory `mock-psp` (labelled MOCK), no PAN/CVV accepted in any code path | Unit responsibility stays within single delivery; no real charges |
| Client certificate / TLS termination | Edge (CDN/WAF) | Not implemented — local HTTP only, no TLS terminator | Out of scope for local demo; CSP + security headers on nginx instead |
| Cloud reference | AWS example mapping | Not deployed | Report marks production as optional |
| OpenTelemetry tool table | "OpenTelemetry" listed as planned | Implemented (see above); Jaeger UI on `http://localhost:16686` | See above |
| Image references | product image field | products drawn as emoji + colour SVG tiles (no external images) | spec/accessibility |

## 4.4 What is explicitly NOT in scope (unchanged from design)

- Survey with retailer/customer (needs real participants)
- Returns/refunds, promotions, invoices, multi-warehouse, marketplace sellers — excluded per feature matrix
- Production cloud deployment, WAF, multi-zone
- PCI DSS assessment, plagiarism score, formal WCAG audit

## 4.5 How to reproduce the evidence

```bash
docker compose up --build          # start stack
node tests/acceptance/run.js       # V-01..V-07, V-10
node tests/load/load.js            # V-12 browse workload (see .env rate limits note)
WORKLOAD=checkout node tests/load/load.js   # V-12 checkout workload
sh scripts/backup-restore.sh backup         # V-11 (requires bash)
```

For V-08/V-09 see `scripts/` and `docs/` (manual procedure in `docs/DEMO_MANUAL_TESTS.md`).
