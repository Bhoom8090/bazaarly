package com.bazaarly.reporting.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "report_orders")
public class ReportOrder {
    @Id
    @Column(name = "order_id", nullable = false, length = 64)
    private String orderId;

    @Column(name = "customer_id", length = 64)
    private String customerId;

    @Column(name = "state", length = 32, nullable = false)
    private String state;

    @Column(name = "total_paise", nullable = false)
    private long totalPaise;

    @Column(name = "currency", length = 8)
    private String currency;

    @Column(name = "placed_at")
    private Instant placedAt;

    @Column(name = "item_count")
    private int itemCount;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
    private List<ReportOrderItem> items = new ArrayList<>();

    public String getOrderId() { return orderId; }
    public void setOrderId(String orderId) { this.orderId = orderId; }
    public String getCustomerId() { return customerId; }
    public void setCustomerId(String customerId) { this.customerId = customerId; }
    public String getState() { return state; }
    public void setState(String state) { this.state = state; }
    public long getTotalPaise() { return totalPaise; }
    public void setTotalPaise(long totalPaise) { this.totalPaise = totalPaise; }
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
    public Instant getPlacedAt() { return placedAt; }
    public void setPlacedAt(Instant placedAt) { this.placedAt = placedAt; }
    public int getItemCount() { return itemCount; }
    public void setItemCount(int itemCount) { this.itemCount = itemCount; }
    public List<ReportOrderItem> getItems() { return items; }
    public void setItems(List<ReportOrderItem> items) { this.items = items; }
}
