import { SpanStatusCode, context, trace, type Attributes } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

type MessageSendTrace = {
  measure<T>(name: string, operation: () => Promise<T>): Promise<T>;
  event(name: string, attributes?: Attributes): void;
};

const disabledTrace: MessageSendTrace = {
  measure: async (_name, operation) => operation(),
  event: () => {},
};

let initialization: Promise<boolean> | undefined;

async function initializeTracing() {
  initialization ??= (async () => {
    const endpointFile = Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE;
    const endpoint = endpointFile
      ? (await Bun.file(endpointFile).text()).trim()
      : Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (!endpoint) return false;

    const provider = new TracerProvider({
      resource: resourceFromAttributes({
        "service.name": Bun.env.OTEL_SERVICE_NAME ?? "coforge-web",
        "service.version": Bun.env.OTEL_SERVICE_VERSION ?? "unknown",
        "deployment.environment": Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "unknown",
      }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({ url: endpoint }),
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    return true;
  })().catch(() => false);
  return initialization;
}

export async function withMessageSendTrace<T>(
  idempotencyKey: string,
  attributes: Attributes,
  operation: (trace: MessageSendTrace) => Promise<T>,
): Promise<T> {
  if (!(await initializeTracing())) return operation(disabledTrace);

  const tracer = trace.getTracer("coforge-web", "1.0.0");
  const root = tracer.startSpan("message.send", {
    attributes: { ...attributes, "coforge.request_id": idempotencyKey },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const handle: MessageSendTrace = {
    async measure(name, nestedOperation) {
      const child = tracer.startSpan(name, undefined, rootContext);
      try {
        return await nestedOperation();
      } finally {
        child.end();
      }
    },
    event(name, eventAttributes) {
      root.addEvent(name, eventAttributes);
    },
  };

  try {
    const result = await operation(handle);
    root.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    root.recordException(error instanceof Error ? error : new Error(String(error)));
    root.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    root.end();
  }
}
