'use strict';
// Centralised configuration with sensible in-docker defaults.
const env = process.env;

module.exports = {
  env: env.NODE_ENV || 'development',
  jwtSecret: env.JWT_SECRET || 'dev_jwt_secret_change_me',
  internalKey: env.INTERNAL_KEY || 'dev_internal_key_change_me',
  pspWebhookSecret: env.PSP_WEBHOOK_SECRET || 'whsec_dev_mock_secret',
  pspApiKey: env.PSP_API_KEY || 'sk_test_mock',
  cookieSecure: (env.COOKIE_SECURE || 'false') === 'true',

  adminEmail: env.ADMIN_EMAIL || 'admin@bazaarly.test',
  adminPassword: env.ADMIN_PASSWORD || 'Admin@12345',
  demoEmail: env.DEMO_EMAIL || 'demo@bazaarly.test',
  demoPassword: env.DEMO_PASSWORD || 'Demo@12345',
  adminMfaEnforce: (env.ADMIN_MFA_ENFORCE || 'false') === 'true',
  adminTotpSecret: env.ADMIN_TOTP_SECRET || 'JBSWY3DPEHPK3PXP',

  reservationTtlSeconds: parseInt(env.RESERVATION_TTL_SECONDS || '600', 10),
  eventMaxAttempts: parseInt(env.EVENT_MAX_ATTEMPTS || '5', 10),
  rateLimitPerMin: parseInt(env.RATE_LIMIT_PER_MIN || '1000', 10),
  authRateLimitPerMin: parseInt(env.AUTH_RATE_LIMIT_PER_MIN || '200', 10),
  searchRateLimitPerMin: parseInt(env.SEARCH_RATE_LIMIT_PER_MIN || '120', 10),
  checkoutRateLimitPerMin: parseInt(env.CHECKOUT_RATE_LIMIT_PER_MIN || '10', 10),
  paymentSandbox: (env.PAYMENT_SANDBOX || 'true') === 'true',
  maxCartQty: parseInt(env.MAX_CART_QTY || '10', 10),

  mongoUri: env.MONGO_URI || 'mongodb://mongo:27017/?replicaSet=rs0',
  redisUrl: env.REDIS_URL || 'redis://redis:6379',
  amqpUrl: env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672',
  smtpHost: env.SMTP_HOST || 'mailpit',
  smtpPort: parseInt(env.SMTP_PORT || '1025', 10),
  pspWebhookUrl: env.PSP_WEBHOOK_URL || 'http://gateway:8080/v1/webhooks/payments/mockpsp',
  mockPspUrl: env.MOCK_PSP_URL || 'http://mock-psp:4010',

  services: {
    identity: env.IDENTITY_URL || 'http://identity:4001',
    catalog: env.CATALOG_URL || 'http://catalog:4002',
    search: env.SEARCH_URL || 'http://search:4003',
    inventory: env.INVENTORY_URL || 'http://inventory:4004',
    cart: env.CART_URL || 'http://cart:4005',
    order: env.ORDER_URL || 'http://order:4006',
    payment: env.PAYMENT_URL || 'http://payment:4007',
    notification: env.NOTIFICATION_URL || 'http://notification:4008',
    fulfilment: env.FULFILMENT_URL || 'http://fulfilment:4009',
    mockPsp: env.MOCK_PSP_URL || 'http://mock-psp:4010',
  },
};
