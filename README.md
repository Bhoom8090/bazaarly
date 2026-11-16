# Bazaarly 🛒

**Bazaarly** is a single-merchant e-commerce web application for the Indian market - an Amazon-like storefront built on **PERN** (PostgreSQL, Express, React, Node) with a microservices architecture.

## What the site does

- **Storefront** — hero + category tiles, catalogue browsing with pagination, full-text search with facets and price filters, product pages with live stock availability
- **Cart & checkout** — Redis-backed cart repriced server-side each read; idempotent checkout saga (reserve stock → authorize payment → commit reservation → confirm)
- **Payments (sandbox)** — mock PSP with `success` / `failure` / `async` / `timeout` test scenarios; HMAC-signed webhooks; automatic reconciliation
- **Order tracking** — live status tracker, state history audit trail, shipment milestones, polling while pending
- **Accounts** — register/login (JWT, HttpOnly cookie, CSRF protection), address book, notification inbox
- **Admin console** — product management with optimistic concurrency, inventory adjustments with audit trail, orders overview, shipment milestone management, search-index rebuild

## Architecture

```
              http://localhost:3000                    http://localhost:8080
             ┌──────────────────────┐                ┌────────────────────┐
  Browser ──►│ frontend (nginx)     │ ─/api/*──────► │ API Gateway        │
             │  SPA + /api proxy    │  strips prefix │  JWT verify, CSRF, │
             └──────────────────────┘                │  rate limit, routes│
                                                     └───────┬────────────┘
           internal network only (x-internal-key required)    │
   ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬─┴───┐
   ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼     ▼
  identity catalog search inventory cart order payment notif fulfilment mock-psp  reporting
  (Node 22 + Express + pg (node-postgres) services, one DB each)  (Java + H2 analytics, no DB)
      ▼      ▼      ▼      ▼          ▼            ▼
    postgres  redis  rabbitmq  .            .            .
 (db/svc) (cart/ (outbox → topic exchange commerce.events / DLQ)
           cache)
```

Every service owns its own PostgreSQL database (one container, eight DBs created by `infra/postgres-init.sql`). Cross-service consistency uses a **transactional outbox** (events committed in the same transaction as data, relayed to RabbitMQ) with idempotent consumers, retry queues and a DLQ.

## What each component is built with

### Frontend — `frontend/`
- **React 18 + TypeScript + Vite** (no UI library; custom CSS, Amazon-like theme: navy `#131921`, orange accent `#ff9900`, yellow buttons `#ffd814`)
- **react-router-dom v6** (HashRouter), emoji-based SVG product tiles (no external images)
- Served by **nginx** in Docker; proxies `/api/*` → gateway (`gateway:8080`), strips the prefix
- Accessibility: skip link, labels, `:focus-visible` rings, `aria-live` regions, keyboard operable

### API Gateway — `services/gateway/`
- **Node 22 + Express 4**, single public entry point (port **8080**)
- Verifies **JWT** (HttpOnly `token` cookie or `Authorization: Bearer`) with a Redis revocation denylist (`revoked:<jti>`)
- **CSRF** double-submit check for cookie-authenticated mutating requests (`X-CSRF-Token` vs token claim)
- **Rate limits** in Redis (global per IP, auth, checkout per user, search)
- Forwards to internal services with injected `x-internal-key` / `x-user-*` / `x-correlation-id` headers (spoofed inbound headers are stripped)
- Serves **OpenAPI 3.1 / Swagger UI** at `/api-docs` (`openapi.yaml`)
- Routes: `/v1/auth/*` → identity · `/v1/products|categories` → catalog · `/v1/search` → search · `/v1/availability` → inventory · `/v1/cart*` → cart · `/v1/checkout|orders*` → order · `/v1/orders/:id/tracking` → fulfilment · `/v1/notifications*` → notification · `/v1/webhooks/payments/*` → payment · `/v1/admin/*` → admin endpoints

### Shared library — `shared/`
Common code used by every service: `config.js` (env), `logger.js` (JSON logs with secret redaction), `http.js` (app factory: correlation-id, Prometheus `http_request_duration_seconds`, `/health`, `/metrics`, internal-key guard, zod validation, `HttpError`, error handler), `db.js` (PostgreSQL pool + `withTxn` transactions), `events.js` (outbox + AMQP consumer with dedupe/retry/DLQ, consumers re-attached after broker restarts), `topology.js` (all queues/bindings declared at connect), `clients.js` (service-to-service HTTP with timeout, retry, per-host circuit breaker), `money.js` (paise integer math, 18% GST inclusive, free shipping ≥ ₹499), `fsm.js` (order/payment/shipment/reservation state machines), `idem.js`, `webhook.js` (HMAC-SHA256 verify, timing-safe, 300s tolerance).

### Services - `services/` (Node 22 + Express + pg (node-postgres) unless noted, own DB)

| Service | Port | DB | Responsibility |
|---|---|---|---|
| reporting **(Java/Spring)** | 4011 | `H2 in-memory` | Analytics API — syncs order snapshot into H2 every 60s; admin summary/top-products/daily-sales/state counts; serves H2 console for demo |
| identity | 4001 | `identity` | Users, bcrypt password hashing, JWT sessions, addresses, admin TOTP MFA, seeds admin + demo users |
| catalog | 4002 | `catalog` | 25 seeded products in 6 categories, cursor pagination, Redis cache, admin CRUD with optimistic `expectedVersion` + audit log + outbox `ProductChanged.v1` |
| search | 4003 | `search` | Read-optimised projection of catalog kept fresh via `ProductChanged.v1`; PostgreSQL full-text (`to_tsvector`) + ILIKE fallback; `/v1/search` with facets/sort/price filter; rebuildable via reindex endpoint |
| inventory | 4004 | `inventory` | Stock balances (`onHand − reserved ≥ 0`), all-or-nothing reservations in one transaction (guarded `$expr` updates), 15s expiry worker, availability (IN/LOW/OUT_OF_STOCK), admin adjustments + audit |
| cart | 4005 | Redis | Per-user cart hash (`cart:<userId>`, 7d TTL), repriced through catalog on every read, max 10/SKU · 50 distinct SKUs |
| order | 4006 | `orders` | Checkout **saga orchestrator**: cart → reprice → `PENDING_VALIDATION` → reserve → `PAYMENT_PENDING` → authorize → commit → `CONFIRMED`; idempotency keys (replay/conflict); 15s sweeper; event consumers |
| payment | 4007 | `payments` | Payment attempts (unique per order, guarded transitions), adapter to mock PSP (stable Idempotency-Key, 3s timeout), HMAC webhook with dedupe + replay protection, 10s reconciler, captures on `OrderConfirmed.v1`, voids on `OrderCancelled.v1` |
| notification | 4008 | `notifications` | Per-user inbox from domain events, deduped; email via nodemailer → **Mailpit**; preferences + unread counts |
| fulfilment | 4009 | `fulfilment` | Shipments created from `OrderConfirmed.v1` (`SHP-<orderId>`), append-only milestone log, guarded transitions, owner-only tracking endpoint, emits `TrackingUpdated.v1` |
| mock-psp | 4010 | — | **In-memory mock** payment provider (sandbox only): payment intents, capture/cancel, 4 test scenarios, duplicate webhook delivery, signs webhooks with `PSP_WEBHOOK_SECRET` |

### Reporting service — `services/reporting/` (Java, Spring Boot + H2)
- **Spring Boot 4 + Java 21 + H2 (in-memory)** - a self-contained analytics API alongside the PERN services
- Polls `GET /internal/admin/orders` (internal-key) on a schedule (`SYNC_INTERVAL_MS`, default 60s) and snapshots orders + items into H2 tables
- Serves admin analytics at `/v1/admin/reports/*` (also exposed through the gateway, admin-role required):
  - `summary` — GMV, revenue orders, avg order value, units sold, by-state counts
  - `orders-by-state` · `top-products?limit=N` · `daily-sales?days=N` (zero-filled) · `status` · `POST sync`
- **H2 console** at `http://localhost:4011/h2-console` (demo; JDBC URL `jdbc:h2:mem:bazaarly_report`, user `sa`, no password)
- Admin UI has a **Reports** tab rendering all of the above
- 5 JUnit tests cover the analytics math (`AnalyticsCalculator`)

### Infrastructure & ops — `infra/`, `docker-compose.yml`
- **PostgreSQL 16** — one database per transactional service (8 DBs created by `infra/postgres-init.sql`); native multi-document transactions inside each service's transaction
- **Redis 7** — cart, catalog cache, rate limiter buckets, JWT revocation denylist
- **RabbitMQ 3.13** (management UI on 15672) — topic exchange `commerce.events`, per-consumer queues, retry queues with per-message TTL (exponential backoff + jitter), DLQ `commerce.dlq`
- **Prometheus** (:9090) — scrapes `/metrics` of every service; alert rules: service down, DLQ growth, outbox backlog
- **Grafana** (:3001, admin/admin) — provisioned Prometheus datasource + “Bazaarly Overview” dashboard (request rate, p95, DLQ, outbox backlog)
- **Mailpit** (:8025 + SMTP 1025) — captures all outbound email; **Miniflare-like mock PSP** above — no real payments
- **Jaeger** (:16686, UI) + **OpenTelemetry** SDK in every Node service (`shared/telemetry.js`) exporting OTLP → trace one checkout across gateway → order → cart/catalog/identity/inventory/payment + mock PSP end-to-end
- **`Dockerfile.service`** - generic image (`ARG SERVICE=<name>`); **`docker-compose.yml`** orchestrates all 13 services + PostgreSQL/Redis/RabbitMQ/Mailpit/Prometheus/Grafana; **`.github/workflows/ci.yml`** runs syntax check, unit tests, frontend build and compose build on push

### Tests & scripts — `tests/`, `scripts/`
- `tests/unit/` — Jest: money math, webhook signature, circuit breaker, FSMs, idempotency hash
- `tests/acceptance/run.js` — V-01..V-10 against the running stack (pagination, **50 concurrent checkouts for 1 unit in stock**, idempotent replay, key reuse, timeout reconciliation, stock release, webhook dedupe, cross-user 404)
- `tests/load/load.js` — V-12 load test (browse workload default; `WORKLOAD=checkout node tests/load/load.js` for the authenticated checkout saga), saves JSON report
- `scripts/backup-restore.sh` - V-11 pg_dump/pg_restore for the stack's databases · `scripts/check-syntax.js`

## Documentation

- [`docs/CH4_ADDENDUM.md`](docs/CH4_ADDENDUM.md) — implemented-vs-report deviations + measured V-01…V-12 results + load-test numbers
- [`docs/DEMO_MANUAL_TESTS.md`](docs/DEMO_MANUAL_TESTS.md) — step-by-step V-08/V-09/V-11 (broker outage, mailpit down, backup/restore)
- [`docs/SECURITY.md`](docs/SECURITY.md) — OWASP-aligned security controls implemented
- [`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md) — WCAG 2.2 code review of the UI
- [`docs/REPLICATION_SPEC.txt`](docs/REPLICATION_SPEC.txt) — original build spec
- Measured load reports: [`docs/load-report-browse.json`](docs/load-report-browse.json), [`docs/load-report-checkout.json`](docs/load-report-checkout.json)

## How to run (Docker Desktop)

**Local PostgreSQL instead of Docker's:** this repo's `.env.example` supports both modes.
- Default `.env.example` uses the bundled Docker PostgreSQL: `docker compose --profile docker-pg up --build`.
- To use a **local PostgreSQL on your machine instead**, create the 8 databases once (as superuser):
  ```sql
  CREATE ROLE bazaarly LOGIN PASSWORD 'strong-password' NOSUPERUSER;
  CREATE DATABASE bazaarly_identity OWNER bazaarly;  -- ...catalog search inventory orders payments notifications fulfilment
  ```
  then set in `.env`: `PGHOST=host.docker.internal  PGUSER=bazaarly  PGPASSWORD=<that password>`
  and run `docker compose up --build` (no `--profile` needed; the Docker PG won't start).
- App data then lives in **your** local PG. Query it directly (pgAdmin or `psql -h localhost -U bazaarly -d bazaarly_orders`).

```bash
# 1. Clone the repo, then from the repo root:
cp .env.example .env        # Windows cmd: copy .env.example .env

# 2. Build and start everything (first run downloads images, ~5-10 min)
#    Fresh clone / machine without local PG: include the bundled Docker PostgreSQL:
docker compose --profile docker-pg up --build

#    Machine WITH local PostgreSQL already set up (this repo's .env is preconfigured for that):
docker compose up --build

# 3. Open the app
#    http://localhost:3000
```

**Seed accounts**

| Role | Email | Password |
|------|-------|----------|
| Demo customer | `demo@bazaarly.test` | `Demo@12345` |
| Admin | `admin@bazaarly.test` | `Admin@12345` |

**Tool URLs**

| Tool | URL | Credentials |
|------|-----|-------------|
| Swagger / OpenAPI | http://localhost:8080/api-docs | — |
| H2 database console (reporting) | http://localhost:4011/h2-console | JDBC `jdbc:h2:mem:bazaarly_report`, user `sa`, no password |
| **Jaeger** (traces, all services) | http://localhost:16686 | search service name, e.g. `order` |
| Mailpit (captured emails) | http://localhost:8025 | — |
| RabbitMQ UI | http://localhost:15672 | guest / guest |
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | — |

**Stop / reset**

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and wipe data
```

**Windows notes:** PowerShell users should use `Copy-Item .env.example .env`. On Windows install Docker Desktop with the default WSL2 backend; run `docker compose up --build` from the project folder.

Environment variables are documented in [`.env.example`](.env.example) (dev defaults are provided; change `JWT_SECRET`/`INTERNAL_KEY` for anything beyond a demo).
