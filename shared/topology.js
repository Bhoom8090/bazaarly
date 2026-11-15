'use strict';
// Every service declares ALL queues + bindings on connect (idempotent),
// so events are never lost regardless of startup order.
const QUEUES = {
  'search.product-changed': ['ProductChanged.v1'],
  'inventory.product-changed': ['ProductChanged.v1'],
  'inventory.order-cancelled': ['OrderCancelled.v1'],
  'order.inventory-events': ['InventoryReserved.v1', 'ReservationExpired.v1'],
  'order.payment-events': ['PaymentAuthorized.v1', 'PaymentFailed.v1'],
  'order.tracking': ['TrackingUpdated.v1'],
  'payment.order-cancelled': ['OrderCancelled.v1'],
  'payment.order-confirmed': ['OrderConfirmed.v1'],
  'notification.events': ['PaymentAuthorized.v1', 'PaymentFailed.v1', 'OrderConfirmed.v1', 'OrderCancelled.v1', 'TrackingUpdated.v1'],
  'fulfilment.order-confirmed': ['OrderConfirmed.v1'],
  'cart.order-confirmed': ['OrderConfirmed.v1'],
};

const EXCHANGE = 'commerce.events';

async function declareAll(ch) {
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue('commerce.dlq', { durable: true });
  for (const [queue, keys] of Object.entries(QUEUES)) {
    await ch.assertQueue(queue, { durable: true });
    for (const key of keys) await ch.bindQueue(queue, EXCHANGE, key);
    // Retry queue dead-letters to the DEFAULT exchange with the main queue's name as
    // routing key, so delayed messages return to exactly the right main queue.
    const retry = `${queue}.retry`;
    await ch.assertQueue(retry, { durable: true, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue } });
  }
}

module.exports = { QUEUES, EXCHANGE, declareAll };
