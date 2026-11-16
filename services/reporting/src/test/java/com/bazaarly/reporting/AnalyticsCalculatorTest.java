package com.bazaarly.reporting;

import com.bazaarly.reporting.service.AnalyticsCalculator;
import com.bazaarly.reporting.service.AnalyticsCalculator.*;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class AnalyticsCalculatorTest {

    private ItemRow item(String sku, int qty, long linePaise) {
        return new ItemRow(sku, sku + " title", qty, linePaise);
    }

    private OrderRow order(String id, String state, long total, LocalDate date) {
        return new OrderRow(id, state, total, date, List.of(item("SKU-A", 1, 1000), item("SKU-B", 2, 4000)));
    }

    private final LocalDate today = LocalDate.now();

    @Test
    void summarizeCountsRevenueStatesOnly() {
        List<OrderRow> orders = List.of(
                order("1", "CONFIRMED", 10000, today),
                order("2", "DELIVERED", 20000, today),
                order("3", "CANCELLED", 5000, today),
                order("4", "PAYMENT_FAILED", 7000, today));
        Summary s = AnalyticsCalculator.summarize(orders);
        assertEquals(4, s.totalOrders());
        assertEquals(2, s.revenueOrders());
        assertEquals(30000, s.gmvPaise());
        assertEquals(15000, s.averageOrderValuePaise());
        assertEquals(6, s.unitsSold());          // 3 units per revenue order × 2
        assertEquals(1, s.cancelled());
        assertEquals(1, s.paymentFailed());
    }

    @Test
    void emptyOrdersYieldZeroAverage() {
        Summary s = AnalyticsCalculator.summarize(List.of());
        assertEquals(0, s.gmvPaise());
        assertEquals(0, s.averageOrderValuePaise());
        assertEquals(0, s.unitsSold());
    }

    @Test
    void topProductsRankedByRevenue() {
        List<OrderRow> orders = List.of(
                order("1", "CONFIRMED", 10000, today),
                order("2", "DELIVERED", 20000, today));
        List<ProductStat> top = AnalyticsCalculator.topProducts(orders, 5);
        assertEquals(2, top.size());
        assertEquals("SKU-B", top.get(0).sku());  // higher revenue
        assertEquals(4, top.get(0).units());
        assertEquals(8000, top.get(0).revenuePaise());
    }

    @Test
    void dailySalesZeroFillsMissingDays() {
        List<OrderRow> orders = List.of(order("1", "CONFIRMED", 10000, today));
        List<DailySale> daily = AnalyticsCalculator.dailySales(orders, 7, today);
        assertEquals(7, daily.size());
        assertEquals(10000, daily.get(6).revenuePaise());
        assertEquals(0, daily.get(0).revenuePaise());
        assertEquals(today, daily.get(6).date());
    }

    @Test
    void ordersByStateSortedByCount() {
        List<OrderRow> orders = List.of(
                order("1", "CONFIRMED", 10000, today),
                order("2", "CONFIRMED", 10000, today),
                order("3", "CANCELLED", 10000, today));
        List<StateCount> states = AnalyticsCalculator.ordersByState(orders);
        assertEquals("CONFIRMED", states.get(0).state());
        assertEquals(2, states.get(0).count());
    }
}
