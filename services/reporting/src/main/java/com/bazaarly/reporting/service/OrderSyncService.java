package com.bazaarly.reporting.service;

import com.bazaarly.reporting.model.ReportOrder;
import com.bazaarly.reporting.model.ReportOrderItem;
import com.bazaarly.reporting.repo.ReportOrderRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Pulls the latest 100 orders from the order service on a schedule and
 * re-snapshots them into H2. Idempotent: upsert by order id, items replaced.
 */
@Service
public class OrderSyncService {
    private static final Logger log = LoggerFactory.getLogger(OrderSyncService.class);

    private final ReportOrderRepository repository;
    private final RestClient restClient;
    private final String internalKey;

    private final AtomicReference<Instant> lastSyncAt = new AtomicReference<>();
    private final AtomicReference<String> lastError = new AtomicReference<>();
    private final AtomicReference<Integer> lastSynced = new AtomicReference<>(0);

    public OrderSyncService(ReportOrderRepository repository,
                            @Value("${reporting.order-url}") String orderUrl,
                            @Value("${reporting.internal-key}") String internalKey) {
        this.repository = repository;
        this.internalKey = internalKey;
        this.restClient = RestClient.builder().baseUrl(orderUrl).build();
    }

    @jakarta.annotation.PostConstruct
    public void onStart() {
        trySync("boot");
    }

    @Scheduled(fixedDelayString = "${reporting.sync-interval-ms:60000}", initialDelayString = "${reporting.sync-initial-delay-ms:3000}")
    public void onSchedule() {
        trySync("schedule");
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> trySync(String trigger) {
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            Map<String, Object> body = restClient.get()
                    .uri("/internal/admin/orders")
                    .header("x-internal-key", internalKey)
                    .header(HttpHeaders.ACCEPT, "application/json")
                    .retrieve()
                    .body(Map.class);
            List<Map<String, Object>> orders = body == null ? List.of() : (List<Map<String, Object>>) body.getOrDefault("orders", List.of());
            int n = upsertAll(orders);
            lastSyncAt.set(Instant.now());
            lastSynced.set(n);
            lastError.set(null);
            log.info("reporting sync ({}) — {} orders snapshotted", trigger, n);
            result.put("ok", true);
            result.put("trigger", trigger);
            result.put("orders", n);
            result.put("syncedAt", lastSyncAt.get().toString());
        } catch (Exception e) {
            lastError.set(e.getMessage());
            log.warn("reporting sync ({}) failed: {}", trigger, e.getMessage());
            result.put("ok", false);
            result.put("trigger", trigger);
            result.put("error", e.getMessage());
        }
        return result;
    }

    @Transactional
    int upsertAll(List<Map<String, Object>> rawOrders) {
        int count = 0;
        for (Map<String, Object> raw : rawOrders) {
            try {
                String id = str(raw.get("_id"));
                if (id == null || id.isBlank()) continue;
                ReportOrder order = repository.findById(id).orElseGet(ReportOrder::new);
                order.setOrderId(id);
                order.setCustomerId(str(raw.get("customerId")));
                order.setState(str(raw.get("state")) == null ? "UNKNOWN" : str(raw.get("state")));
                order.setCurrency("INR");
                Map<String, Object> pricing = raw.get("pricing") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
                order.setTotalPaise(num(pricing.get("total")));
                order.setPlacedAt(instant(raw.get("createdAt")));
                // Replace items atomically
                order.getItems().clear();
                List<Map<String, Object>> items = raw.get("items") instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
                int units = 0;
                for (Map<String, Object> item : items) {
                    ReportOrderItem it = new ReportOrderItem();
                    it.setOrder(order);
                    it.setSku(str(item.get("sku")) == null ? "UNKNOWN" : str(item.get("sku")));
                    it.setTitle(str(item.get("title")));
                    it.setQuantity((int) num(item.get("quantity")));
                    it.setLineTotalPaise(num(item.get("lineTotal")));
                    order.getItems().add(it);
                    units += it.getQuantity();
                }
                order.setItemCount(units);
                repository.save(order);
                count++;
            } catch (Exception e) {
                log.warn("skipping order in sync: {}", e.getMessage());
            }
        }
        return count;
    }

    public Map<String, Object> status() {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("lastSyncAt", lastSyncAt.get() == null ? null : lastSyncAt.get().toString());
        s.put("ordersSynced", lastSynced.get());
        s.put("lastError", lastError.get());
        s.put("ordersInH2", repository.count());
        return s;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static long num(Object o) {
        if (o == null) return 0L;
        if (o instanceof Number n) return n.longValue();
        try {
            return Long.parseLong(String.valueOf(o));
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    private static Instant instant(Object o) {
        if (o == null) return null;
        try {
            return Instant.parse(String.valueOf(o));
        } catch (Exception e) {
            return null;
        }
    }
}
