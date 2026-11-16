package com.bazaarly.reporting.web;

import com.bazaarly.reporting.service.AnalyticsCalculator;
import com.bazaarly.reporting.service.AnalyticsService;
import com.bazaarly.reporting.service.OrderSyncService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class ReportsController {

    private final AnalyticsService analytics;
    private final OrderSyncService sync;

    public ReportsController(AnalyticsService analytics, OrderSyncService sync) {
        this.analytics = analytics;
        this.sync = sync;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of("status", "ok", "service", "reporting", "uptime", ProcessHandle.current().info().startInstant().map(i -> java.time.Duration.between(i, java.time.Instant.now()).getSeconds()).orElse(0L));
    }

    // GET /v1/admin/reports/status  — last sync + row count
    @GetMapping("/v1/admin/reports/status")
    public Map<String, Object> status() {
        Map<String, Object> s = new LinkedHashMap<>(sync.status());
        s.put("service", "reporting");
        return s;
    }

    // GET /v1/admin/reports/summary — GMV, order counts, AOV, units sold
    @GetMapping("/v1/admin/reports/summary")
    public Map<String, Object> summary() {
        return analytics.summary();
    }

    // GET /v1/admin/reports/orders-by-state — [{state, count}]
    @GetMapping("/v1/admin/reports/orders-by-state")
    public Map<String, Object> ordersByState() {
        List<AnalyticsCalculator.StateCount> rows = analytics.ordersByState();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("states", rows.stream().map(r -> Map.of("state", r.state(), "count", r.count())).toList());
        return out;
    }

    // GET /v1/admin/reports/top-products?limit=5 — best sellers by revenue
    @GetMapping("/v1/admin/reports/top-products")
    public Map<String, Object> topProducts(@RequestParam(defaultValue = "5") int limit) {
        List<AnalyticsCalculator.ProductStat> rows = analytics.topProducts(Math.min(Math.max(limit, 1), 25));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("products", rows.stream().map(r -> {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("sku", r.sku());
            p.put("title", r.title());
            p.put("units", r.units());
            p.put("revenuePaise", r.revenuePaise());
            return p;
        }).toList());
        return out;
    }

    // GET /v1/admin/reports/daily-sales?days=7 — zero-filled day buckets
    @GetMapping("/v1/admin/reports/daily-sales")
    public Map<String, Object> dailySales(@RequestParam(defaultValue = "7") int days) {
        List<AnalyticsCalculator.DailySale> rows = analytics.dailySales(Math.min(Math.max(days, 1), 31));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("days", rows.stream().map(r -> Map.of("date", r.date().toString(), "orders", r.orders(), "revenuePaise", r.revenuePaise())).toList());
        return out;
    }

    // POST /v1/admin/reports/sync — force refresh from the order service
    @PostMapping("/v1/admin/reports/sync")
    public ResponseEntity<Map<String, Object>> syncNow() {
        Map<String, Object> result = sync.trySync("manual");
        return ResponseEntity.ok(result);
    }
}
