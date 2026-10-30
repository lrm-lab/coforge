import { Writable } from "node:stream";
import { configure, getJsonLinesFormatter, getStreamSink } from "@logtape/logtape";

/**
 * The `__pi-chat` worker's only log destination: stderr. stdout carries the JSONL protocol, so
 * logs must never go through the console sinks. Called once by the worker's entrypoint; library
 * modules only take category loggers. Warnings and above only — turns log at most a warning, and
 * a chat session must not flood the supervising process.
 */
export async function configurePiChatLogging(): Promise<void> {
  await configure({
    reset: true,
    sinks: {
      stderr: getStreamSink(Writable.toWeb(process.stderr), {
        formatter: getJsonLinesFormatter({ properties: "flatten" }),
      }),
    },
    loggers: [
      { category: ["coforge", "pi-chat"], lowestLevel: "warning", sinks: ["stderr"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["stderr"] },
    ],
  });
}
