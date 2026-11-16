# Security Review — Bazaarly

This document summarises the security controls implemented in the platform, mapped to the OWASP API Security Top 10 (2023) and the design-stage threat model (§3.4.9).

## Authentication & sessions

- Passwords hashed with bcrypt (cost 10). Demo/dev seed accounts only; no real user PII.
- Session = JWT (1h expiry) in an **HttpOnly, SameSite=Lax** cookie (`secure` configurable via `COOKIE_SECURE`).
- `jti` revocation denylist in Redis on `POST /v1/auth/logout`; revoked tokens fail verification everywhere.
- Admin accounts may enforce TOTP MFA (`ADMIN_MFA_ENFORCE=true`); secret configurable, seeded `JBSWY3DPEHPK3PXP`.
- `x-user-*` and `x-internal-key` headers from clients are **stripped at the gateway** and re-injected only by it; services reject calls without the internal key (except `/health`, `/metrics`).

## Authorization (object-level)

- Ownership enforced on cart/order/address endpoints from the verified principal (`x-user-id` set by gateway), never from client input. Cart key = `userId` from the token, always.
- Cross-user order read returns **404** (existence not leaked) and writes a `security_audit` row.
- Admin role required on `/v1/admin/*`; catalog price/stock changes require an audit reason and are version-guarded (optimistic concurrency).

## Injection / XSS / CSRF

- All service input validated with zod schemas (bounded lengths, formats for email/phone/pincode).
- Parameterized data access via `pg` (`$1, $2` placeholders, never string-concatenated values).
- React escapes output; no `dangerouslySetInnerHTML`.
- CSRF: cookie-authenticated mutating requests must echo `X-CSRF-Token` equal to the token's `csrf` claim (double-submit). Mismatch → 403. Bearer-authenticated (non-cookie) requests are exempt.
- Security headers on nginx (CSP with `script-src 'self'`, frame-ancestors 'self', X-Frame-Options SAMEORIGIN, nosniff, Referrer-Policy, Permissions-Policy disabling camera/mic/geo).

## Resource consumption

- Fixed-window rate limits in Redis: global per-IP (`RATE_LIMIT_PER_MIN`=1000), auth attempts (`AUTH_RATE_LIMIT_PER_MIN`=200), checkout (`CHECKOUT_RATE_LIMIT_PER_MIN`=10/user), search (`SEARCH_RATE_LIMIT_PER_MIN`=120/user).
- Search query max 100 chars, `limit` capped at 40; cart max 10 units/SKU and 50 distinct SKUs; order items snapshot repriced server-side; paise integer math (no floats).

## Payment data (PCI DSS posture)

- No PAN/CVV accepted, stored, logged, or returned anywhere in code. Payment intent handled by mock PSP over HTTP with Bearer key; PSP echoes no card data. Webhooks are HMAC-SHA256 verified with timestamp tolerance (300s) and `timingSafeEqual`.
- Body sha256 of a canonical request is logged for idempotency verification, never card data.
- Logs redact keys matching pan|cvv|card|password|secret|token|authorization|cookie.

## Webhooks / broker

- Event envelope carries `event_id`, `correlation_id`, `causation_id`; consumers dedupe via `processed_events` unique key; out-of-order and duplicate deliveries tolerated; unprocessable messages land in `commerce.dlq` after 5 attempts with backoff+jitter (`notification_events` fails independently of order state).

## Observability & audit

- `security_audit` (orders) and `catalog.audit` (product changes), `inventory.inventory_adjustments` (stock changes) persist reason, admin id, timestamp.
- Prometheus scrapes all services; alerts for service down, DLQ growth, outbox backlog.
- Grafana dashboard: request rate, p95 latencies, DLQ count, outbox unpublished backlog.
- `x-correlation-id` propagated HTTP + events + logs for trace reconstruction; OpenTelemetry traces in Jaeger (`serviceName` per service).

## Known limitations (accepted for this delivery)

- Local HTTP only (no TLS terminator in the demo stack); production target would terminate TLS at edge.
- Mock PSP is in-memory and clearly labelled MOCK; not a real payment integration.
- Admin MFA is opt-in via env (`ADMIN_MFA_ENFORCE=false` default) so the demo stays usable with shared credentials.
- Secrets in `.env.example` are dev defaults and documented as such; real deployments must override.
- Dependency pinning via `package-lock.json`; no signed images or SBOM scan in CI yet.
- Search projection and outbox relay rely on at-least-once delivery; consumer dedupe is the correctness mechanism.
