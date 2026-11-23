import { expect, spyOn, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { withMessageSendTrace } from "#src/server/observability/tracing.server";
import { inFreshTestProcess } from "./helpers/fresh-test-process";

const name = "unconfigured message tracing runs the send without a tracer";

test(name, () =>
  inFreshTestProcess(import.meta.path, name, async () => {
    delete Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE;
    const getTracer = spyOn(trace, "getTracer");
    try {
      const sent = { sequence: 42 };
      const send = async () => sent;
      expect(
        await withMessageSendTrace(
          "request",
          { "coforge.conversation_id": "conversation" },
          (handle) => handle.measure("message.persist_and_publish", send),
        ),
      ).toBe(sent);
      const error = new Error("send setup failed");
      await withMessageSendTrace("failed-request", {}, async (handle) => {
        const pending = handle.measure("message.persist_and_publish", () => {
          throw error;
        });
        await expect(pending).rejects.toBe(error);
      });
      expect(getTracer).not.toHaveBeenCalled();
    } finally {
      getTracer.mockRestore();
    }
  }),
);
