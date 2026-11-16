package com.bazaarly.reporting.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

@Service
public class AnalyticsService {

    private final com.bazaarly.reporting.repo.ReportOrderRepository repository;

    public AnalyticsService(com.bazaarly.reporting.repo.ReportOrderRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<AnalyticsCalculator.OrderRow> loadRows() {
        return repository.findAll().stream()
                .map(o -> new AnalyticsCalculator.OrderRow(
                        o.getOrderId(),
                        o.getState(),
                        o.getTotalPaise(),
                        o.getPlacedAt() == null ? null : LocalDate.ofInstant(o.getPlacedAt(), ZoneId.systemDefault()),
                        o.getItems().stream()
                                .map(i -> new AnalyticsCalculator.ItemRow(i.getSku(), i.getTitle(), i.getQuantity(), i.getLineTotalPaise()))
                                .toList()))
                .toList();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary() {
        AnalyticsCalculator.Summary s = AnalyticsCalculator.summarize(loadRows());
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("totalOrders", s.totalOrders());
        m.put("revenueOrders", s.revenueOrders());
        m.put("gmvPaise", s.gmvPaise());
        m.put("averageOrderValuePaise", s.averageOrderValuePaise());
        m.put("unitsSold", s.unitsSold());
        m.put("byState", Map.of(
                "CONFIRMED", s.confirmed(),
                "FULFILLING", s.fulfilling(),
                "SHIPPED", s.shipped(),
                "DELIVERED", s.delivered(),
                "CANCELLED", s.cancelled(),
                "PAYMENT_FAILED", s.paymentFailed(),
                "EXPIRED", s.expired()));
        m.put("currency", "INR");
        return m;
    }

    @Transactional(readOnly = true)
    public List<AnalyticsCalculator.StateCount> ordersByState() {
        return AnalyticsCalculator.ordersByState(loadRows());
    }

    @Transactional(readOnly = true)
    public List<AnalyticsCalculator.ProductStat> topProducts(int limit) {
        return AnalyticsCalculator.topProducts(loadRows(), limit);
    }

    @Transactional(readOnly = true)
    public List<AnalyticsCalculator.DailySale> dailySales(int days) {
        return AnalyticsCalculator.dailySales(loadRows(), days, LocalDate.now());
    }
}
