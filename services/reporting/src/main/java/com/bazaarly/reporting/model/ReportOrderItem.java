package com.bazaarly.reporting.model;

import jakarta.persistence.*;

@Entity
@Table(name = "report_order_items", indexes = @Index(name = "idx_item_sku", columnList = "sku"))
public class ReportOrderItem {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private ReportOrder order;

    @Column(name = "sku", length = 64, nullable = false)
    private String sku;

    @Column(name = "title", length = 512)
    private String title;

    @Column(name = "quantity", nullable = false)
    private int quantity;

    @Column(name = "line_total_paise", nullable = false)
    private long lineTotalPaise;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public ReportOrder getOrder() { return order; }
    public void setOrder(ReportOrder order) { this.order = order; }
    public String getSku() { return sku; }
    public void setSku(String sku) { this.sku = sku; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public int getQuantity() { return quantity; }
    public void setQuantity(int quantity) { this.quantity = quantity; }
    public long getLineTotalPaise() { return lineTotalPaise; }
    public void setLineTotalPaise(long lineTotalPaise) { this.lineTotalPaise = lineTotalPaise; }
}
