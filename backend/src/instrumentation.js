import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

const honeycombApiKey = process.env.HONEYCOMB_API_KEY;

if (honeycombApiKey && honeycombApiKey !== 'your_honeycomb_api_key_here' && honeycombApiKey !== '') {
  console.log('👁️ OpenTelemetry Instrumentation initialized. Exporting traces to Honeycomb...');
  
  const sdk = new NodeSDK({
    serviceName: 'cx-triage-agent-service',
    traceExporter: new OTLPTraceExporter({
      url: 'https://api.honeycomb.io/v1/traces',
      headers: {
        'x-honeycomb-team': honeycombApiKey,
      },
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
} else {
  console.log('⚠️ OpenTelemetry tracing disabled (HONEYCOMB_API_KEY is missing or placeholder).');
}
