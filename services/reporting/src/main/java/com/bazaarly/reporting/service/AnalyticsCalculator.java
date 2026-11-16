package com.bazaarly.reporting.service;

import java.time.LocalDate;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Pure analytics math — no Spring, no DB. Unit-tested in AnalyticsCalculatorTest.
 * All money is integer paise.
 */
public final class AnalyticsCalculator {

    public record ItemRow(String sku, String title, int quantity, long lineTotalPaise) {}
    public record OrderRow(String orderId, String state, long totalPaise, LocalDate placedDate, List<ItemRow> items) {}

    private AnalyticsCalculator() {}

    public static boolean isRevenueState(String state) {
        // Money actually committed to the order (goods are/were paid for).
        return Set.of("CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED").contains(state);
    }

    public record Summary(long totalOrders, long revenueOrders, long gmvPaise, long averageOrderValuePaise,
                          long unitsSold, long confirmed, long fulfilling, long shipped, long delivered,
                          long cancelled, long paymentFailed, long expired) {}

    public static Summary summarize(List<OrderRow> orders) {
        long gmv = 0, units = 0, confirmed = 0, fulfilling = 0, shipped = 0, delivered = 0,
                cancelled = 0, failed = 0, expired = 0, revenueOrders = 0;
        for (OrderRow o : orders) {
            switch (o.state()) {
                case "CONFIRMED" -> confirmed++;
                case "FULFILLING" -> fulfilling++;
                case "SHIPPED" -> shipped++;
                case "DELIVERED" -> delivered++;
                case "CANCELLED" -> cancelled++;
                case "PAYMENT_FAILED" -> failed++;
                case "EXPIRED" -> expired++;
                default -> { }
            }
            if (isRevenueState(o.state())) {
                revenueOrders++;
                gmv += o.totalPaise();
                units += o.items().stream().mapToLong(ItemRow::quantity).sum();
            }
        }
        long aov = revenueOrders == 0 ? 0 : Math.round((double) gmv / revenueOrders);
        return new Summary(orders.size(), revenueOrders, gmv, aov, units, confirmed, fulfilling, shipped,
                delivered, cancelled, failed, expired);
    }

    public record StateCount(String state, long count) {}

    public static List<StateCount> ordersByState(List<OrderRow> orders) {
        return orders.stream()
                .collect(Collectors.groupingBy(OrderRow::state, Collectors.counting()))
                .entrySet().stream()
                .map(e -> new StateCount(e.getKey(), e.getValue()))
                .sorted(Comparator.comparingLong(StateCount::count).reversed())
                .collect(Collectors.toList());
    }

    public record ProductStat(String sku, String title, long units, long revenuePaise) {}

    public static List<ProductStat> topProducts(List<OrderRow> orders, int limit) {
        Map<String, ProductStat> acc = new HashMap<>();
        for (OrderRow o : orders) {
            if (!isRevenueState(o.state())) continue;
            for (ItemRow item : o.items()) {
                ProductStat cur = acc.get(item.sku());
                long units = (cur != null ? cur.units() : 0) + item.quantity();
                long rev = (cur != null ? cur.revenuePaise() : 0) + item.lineTotalPaise();
                acc.put(item.sku(), new ProductStat(item.sku(), item.title(), units, rev));
            }
        }
        return acc.values().stream()
                .sorted(Comparator.comparingLong(ProductStat::revenuePaise).reversed())
                .limit(Math.max(1, limit))
                .collect(Collectors.toList());
    }

    public record DailySale(LocalDate date, long orders, long revenuePaise) {}

    public static List<DailySale> dailySales(List<OrderRow> orders, int days, LocalDate today) {
        LocalDate from = today.minusDays(Math.max(1, days) - 1L);
        Map<LocalDate, List<OrderRow>> byDay = orders.stream()
                .filter(o -> o.placedDate() != null && !o.placedDate().isBefore(from) && isRevenueState(o.state()))
                .collect(Collectors.groupingBy(OrderRow::placedDate));
        List<DailySale> out = new ArrayList<>();
        for (LocalDate d = from; !d.isAfter(today); d = d.plusDays(1)) {
            List<OrderRow> day = byDay.getOrDefault(d, List.of());
            long revenue = day.stream().mapToLong(OrderRow::totalPaise).sum();
            out.add(new DailySale(d, day.size(), revenue));
        }
        return out;
    }
}
