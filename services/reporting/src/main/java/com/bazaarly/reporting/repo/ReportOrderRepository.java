package com.bazaarly.reporting.repo;

import com.bazaarly.reporting.model.ReportOrder;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface ReportOrderRepository extends JpaRepository<ReportOrder, String> {
}
