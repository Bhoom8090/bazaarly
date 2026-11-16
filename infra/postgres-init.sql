-- One database per transactional service. Runs once on first postgres boot.
CREATE DATABASE bazaarly_identity;
CREATE DATABASE bazaarly_catalog;
CREATE DATABASE bazaarly_search;
CREATE DATABASE bazaarly_inventory;
CREATE DATABASE bazaarly_orders;
CREATE DATABASE bazaarly_payments;
CREATE DATABASE bazaarly_notifications;
CREATE DATABASE bazaarly_fulfilment;
