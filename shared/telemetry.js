'use strict';
// OpenTelemetry bootstrap — loaded BEFORE any other require() in each service.
// Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set (docker-compose sets it to
// http://jaeger:4318 for every service). Traces one checkout across all services.
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  module.exports = {};
  return;
}

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || process.env.SERVICE || 'bazaarly-service';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
  traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-winston': { enabled: false },
    }),
  ],
});

try {
  sdk.start();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'opentelemetry started', service: serviceName, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }));
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('opentelemetry failed to start (continuing without tracing):', err.message);
}

process.on('SIGTERM', () => { sdk.shutdown().finally(() => process.exit(0)); });

module.exports = sdk;
