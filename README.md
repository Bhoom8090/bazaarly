# Bazaarly 🛒

**Bazaarly** is a single-merchant e-commerce web application for the Indian market — an Amazon-like storefront built on the **MERN** stack (MongoDB, Express, React, Node) with a microservices architecture.

> Amazon-like **theme** only — not affiliated with Amazon. INR currency, sandbox payments, simulated carrier, single merchant. Demo project.

## What the site does

- **Storefront** — hero + category tiles, catalogue browsing with pagination, full-text search with facets and price filters, product pages with live stock availability
- **Cart & checkout** — Redis-backed cart repriced server-side; idempotent checkout (reserve stock → authorize payment → commit reservation → confirm)
- **Payments (sandbox)** — mock payment provider with `success` / `failure` / `async` / `timeout` test scenarios; HMAC-signed webhooks; automatic reconciliation
- **Order tracking** — live status tracker, state history audit trail, shipment milestones, polling while pending
- **Accounts** — register/login (JWT, HttpOnly cookie, CSRF protection), addresses, notification inbox
- **Admin console** — product management, inventory adjustments with audit trail, orders overview, shipment milestone management, search-index rebuild

**Tech stack:** MongoDB (replica set) · Express · Node 20 · React 18 + TypeScript + Vite · Redis · RabbitMQ · Docker Compose · Prometheus + Grafana · Mailpit

## How to run (Docker Desktop)

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running (Windows/macOS/Linux), ~8 GB free RAM. Ports 3000, 8080, 9090, 3001, 8025, 15672, 1025 must be free.

```bash
# 1. Clone the repo, then from the repo root:
cp .env.example .env        # Windows cmd: copy .env.example .env

# 2. Build and start everything (first run downloads images, ~5-10 min)
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
