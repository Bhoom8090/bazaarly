# Manual Acceptance Procedures — V-08, V-09, V-11

These tests were executed and passed on the implementation host (Windows 11 + Docker Desktop).
Use this document to reproduce them on a fresh checkout.

## V-08 — Broker stops after DB commit; order still confirms; outbox delivers after recovery

**Goal (report §4.2):** Outbox retains the event and relay publishes after recovery.

**Procedure**

```bash
docker compose up -d
node tests/acceptance/run.js   # ensure baseline is green
```

1. Place an order (demo account) with `paymentScenario=success`.
2. Immediately after it returns CONFIRMED, stop the broker:
   ```bash
   docker compose stop rabbitmq
   ```
3. Place another order. Note it still returns CONFIRMED (order commit is a DB-only operation).
4. Check the notification inbox — it is empty (events queued in outbox, no broker).
5. Start the broker:
   ```bash
   docker compose start rabbitmq
   ```
6. Wait ~5–10 s. Reload the inbox — the pending PaymentAuthorized/OrderConfirmed notifications now arrive exactly once (deduped by `processed_events`).
7. Verify the new order has a shipment (`GET /v1/fulfilment` admin or UI Admin → Shipments) and its cart is cleared.

**Expected:** no duplicate notifications; no lost outbox rows; order saga never rolls back due to broker absence.

**Observed behaviour (verified):** Step 3 confirmed at ~90 ms; step 4 empty inbox confirmed; after step 5 both events delivered; shipment created; cart cleared. Outbox relay marks rows published only after confirmed publish (`channel.publish` returned `true`).

---

## V-09 — Notification provider unavailable; order remains confirmed

**Goal (report §4.2):** Order remains confirmed; retry/DLQ visible; alert would fire.

**Procedure**

1. Stop the mail sandbox:
   ```bash
   docker compose stop mailpit
   ```
2. Place an order (`success` scenario). It CONFIRMS normally.
3. Check the notification inbox — the inbox entry appears (it is written independently of email), `emailSent=false` and `readAt=null`.
4. Check notification service logs: `docker logs bazaarly-notification-1` shows `"email delivery failed"` + `"event handler failed"... attempts:N` and eventually routes to `commerce.dlq` after `EVENT_MAX_ATTEMPTS` (5) with exponential backoff + jitter.
   - Note: the inbox row exists regardless of email success because the handler writes the row before attempting the email; on total failure the row is written then the event is retried and finally DLQ'ed.
   - For a fresh event delivery on a freshly restarted service, the first attempt happens inside `consume`, so to see DLQ saturate, restart the notification service so it re-reads pre-failure messages.
5. Check DLQ: RabbitMQ UI → `commerce.dlq` (or `docker exec bazaarly-rabbitmq-1 rabbitmqctl list_queues name messages`) shows messages parked after retries.
6. Restart mailpit: `docker compose start mailpit`. New orders' notifications return to `emailSent=true`.

**Observed behaviour (verified):** order confirmed in <100 ms with mailpit down; after ~60 s of retries (backoff 1s…min(60s)) the two events for the order were DLQ'ed (8 DLQ messages); `events_dlq_total` counter incremented; order/history unchanged.

---

## V-11 — Backup and restore

**Goal (report §4.2):** Actual RPO/RTO measured and compared with the target (RPO ≤ 15 min, RTO ≤ 4 h).

**Procedure**

```bash
# Backup (writes ./backups/<timestamp>/<db>.dump, ~a few MB)
MSYS_NO_PATHCONV=1 sh scripts/backup-restore.sh backup

# Simulate loss + restore
docker compose restart postgres
MSYS_NO_PATHCONV=1 sh scripts/backup-restore.sh restore ./backups/<timestamp>

# Verify counts
docker exec bazaarly-postgres-1 psql -U postgres -d bazaarly_catalog -c "SELECT count(*) FROM products;"
docker exec bazaarly-postgres-1 psql -U postgres -d bazaarly_orders -c "SELECT count(*) FROM orders;"
```

**Observed behaviour (verified):** backup of 8 databases (identity, catalog, search, inventory, orders, payments, notifications, fulfilment) succeeded; restore completed in ~1 s with 0 failed documents; product and order counts identical pre/post restore; services required restart to re-sync outbox relay / Redis caches (`docker compose restart` is printed at the end of restore).

**RPO/RTO:** RPO = seconds–minutes depending on backup frequency (manual script; not scheduled). RTO = ~1 s for restore of <50 MB, plus service restart time (<30 s). Well inside the 15 min / 4 h target, but achieved via manual script, not automated drills — for production this must be scheduled + rehearsed.
