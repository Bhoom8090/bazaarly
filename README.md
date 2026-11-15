# Bazaarly 🛒

**Bazaarly** is a single-merchant e-commerce platform for the Indian market — an Amazon-like shopping experience built on a **MERN** foundation (**M**ongoDB, **E**xpress, **R**eact, **N**ode) with a microservices architecture. It is a college System Design project implementing the report *“Scalable Microservices-Based E-Commerce Platform”*.

> Amazon-like **theme** only — not affiliated with Amazon. INR currency, sandbox payments, simulated carrier, single merchant. For demonstration, not commerce.

---

## Features

- **Storefront** — home with hero + category tiles, catalogue browse with cursor pagination, full-text search with facets and price filters, product pages with live stock availability (IN STOCK / LOW / OUT OF STOCK)
- **Cart & checkout** — Redis-backed cart repriced server-side on every read, idempotent checkout saga: *reserve stock → authorize payment → commit reservation → confirm*
- **Payments (sandbox)** — mock PSP with `success` / `failure` / `async` / `timeout` scenarios, HMAC-signed webhooks with replay protection, automatic reconciliation for lost responses
- **Order tracking** — live status tracker, state history (audit trail), shipment milestones, polling while pending
- **Accounts** — register/login (JWT in HttpOnly cookie + CSRF protection + Redis token revocation), addresses, notification inbox, demo + admin seed users
- **Admin console** — product management with optimistic concurrency, inventory adjustments with audit trail, order overview, shipment milestone management, search-index rebuild
- **Platform** — transactional outbox + RabbitMQ topic exchange, per-service databases, Prometheus metrics, Grafana dashboard, DLQ, correlation-id tracing through HTTP and events

## Tech stack

MongoDB (1-node replica set, multi-document transactions) · Express · Node 20 · React 18 + TypeScript + Vite · Redis · RabbitMQ · Docker Compose · Prometheus + Grafana · Mailpit

## Architecture

```
                 http://localhost:3000                     http://localhost:8080
                ┌──────────────────────┐                  ┌────────────────────┐
   Browser ───► │ frontend (nginx)     │ ──/api/*───────► │ API Gateway        │
                │  SPA + /api proxy    │   (strips /api)  │  JWT verify, CSRF, │
                └──────────────────────┘                  │  rate limit, routes│
                                                          └───────┬────────────┘
            internal network only (x-internal-key required)        │
   ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼          ▼          ▼          ▼          ▼          ▼
 identity  catalog    search    inventory    cart      order     payment  notification fulfilment  mock-psp
 (4001)    (4002)     (4003)    (4004)      (4005)    (4006)    (4007)    (4008)        (4009)    (4010)
   └──────────┴────┬─────┴────────┴─────┬──────┴────────┴─────────┴───────────┴──────────┘
                   ▼                    ▼                       ▼
                 mongo (rs0)          redis                 rabbitmq (commerce.events / .dlq)
            one DB per service   cart + cache + ratelimit   outbox → topic exchange
```

Each service owns its own MongoDB database (`identity`, `catalog`, `search`, `inventory`, `orders`, `payments`, `notifications`, `fulfilment`). State changes that must be atomic (e.g. *order confirmed* + *cart cleared* + *stock deducted*) are done either inside one service’s transaction via the **transactional outbox** pattern, or driven to consistency via idempotent event consumers.

## Quick start (Docker Desktop)

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS/Linux). ~8 GB RAM recommended. Ports 3000, 8080, 9090, 1025, 15672, 8025, 3001, 27017, 6379, 5672 must be free.

```bash
# 1. Clone/unpack the repo, then from the repo root:
cp .env.example .env          # Windows cmd: copy .env.example .env

# 2. Build and start everything (first run downloads images, ~5-10 min)
docker compose up --build

# 3. Open the app
#    Shop:    http://localhost:3000
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
| Mailpit (captured emails) | http://localhost:8025 | — |
| RabbitMQ UI | http://localhost:15672 | guest / guest |
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | — |

**Stop / reset**

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and wipe MongoDB/Grafana volumes
```

## Windows / macOS / Linux notes

- `docker compose version` (v2) is used. On older Docker Desktop, `docker-compose` also works if the binary is present.
- On Windows PowerShell, use `copy .env.example .env` instead of `cp`.
- First boot replica-set init is handled automatically by the `mongo-init` one-shot container.

## Running tests

Unit tests (no stack required):

```bash
npm install
npm test        # jest: money, webhook signature, circuit breaker, FSM, idempotency hash
```

Acceptance tests (stack must be running via `docker compose up`):

```bash
node tests/acceptance/run.js          # V-01..V-07, V-10
# V-08: pause RabbitMQ mid-checkout and watch the order settle after recovery
# V-09: stop Mailpit; orders still confirm, email retries/DLQ
# V-11: sh scripts/backup-restore.sh backup
BASE_URL=http://localhost:8080 node tests/load/load.js   # V-12 load test
```

## Environment variables

See [`.env.example`](.env.example). Highlights:

- `JWT_SECRET`, `INTERNAL_KEY` — shared secrets (change for anything real)
- `PSP_WEBHOOK_SECRET`, `PSP_API_KEY` — mock-PSP credentials (sandbox)
- `ADMIN_MFA_ENFORCE` — set `true` to require the TOTP code for admin login (secret `ADMIN_TOTP_SECRET`)
- `RESERVATION_TTL_SECONDS` (600) — stock hold duration during checkout
- `EVENT_MAX_ATTEMPTS` (5) — retries before an event goes to `commerce.dlq`
- `RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` — gateway rate limits

## Project layout

```
bazaarly/
├── docker-compose.yml       # full stack: 13 services + mongo/redis/rabbitmq/mailpit/prom/grafana
├── Dockerfile.service       # generic image, ARG SERVICE=<name>
├── package.json             # backend workspace deps
├── shared/                  # shared library (config, logger, http, db, events, clients, money, fsm, idem, webhook)
├── services/                # gateway, identity, catalog, search, inventory, cart, order, payment, notification, fulfilment, mock-psp
│   └── gateway/openapi.yaml # OpenAPI 3.1 spec served at /api-docs
├── frontend/                # React 18 + TS + Vite, nginx Dockerfile, proxies /api -> gateway
├── infra/                   # prometheus.yml, alerts.yml, grafana provisioning + dashboard
├── tests/                   # unit (jest), acceptance (V-01..V-10), load (V-12)
├── scripts/                 # backup-restore.sh (V-11), check-syntax.js
├── docs/REPLICATION_SPEC.txt
└── .github/workflows/ci.yml # CI: syntax check + unit tests + frontend build + compose build
```

## Security notes (built-in)

- JWT (1h) in HttpOnly `SameSite=Lax` cookie; `jti` revocation denylist in Redis on logout
- CSRF: mutating cookie-authenticated requests must echo `X-CSRF-Token` (double-submit vs. token claim)
- Internal services require `x-internal-key`; gateway strips inbound `x-user-*` / `x-internal-key` headers
- Webhooks: HMAC-SHA256 with 300-second tolerance, timing-safe compare, replay dedupe
- Idempotency keys (8–128 chars) for checkout; SHA-256 of the canonical body for change detection
- Secrets redacted from structured logs (`pan|cvv|card|password|secret|token|...`)
- Admin role guard on all `/v1/admin/*`; cross-user order reads return 404 and write a `security_audit` row

## Declared deviations from the report

1. **PostgreSQL → MongoDB** (asked for MERN). Mongo runs as a 1-node replica set so multi-document transactions work.
2. **OpenTelemetry → correlation-id propagation** across HTTP + events + JSON logs.
3. Payment is a **mock PSP** (`mock-psp`, in-memory); carrier is simulated by the fulfilment service state machine.

## GitHub upload

```bash
git init -b main
git add .
git commit -m "Initial commit: Bazaarly MERN e-commerce platform"
gh repo create bazaarly --public --source=. --push   # if you use the GitHub CLI
# or: create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/bazaarly.git
git push -u origin main
```
