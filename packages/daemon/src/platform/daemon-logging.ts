import { AsyncLocalStorage } from "node:async_hooks";
import { getRotatingFileSink } from "@logtape/file";
import { configure, getJsonLinesFormatter } from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, type FieldPattern, redactByField } from "@logtape/redaction";
import { prepareDaemonLogFile } from "./daemon-log-file";
import { markStartup } from "./startup-timing";

/** The token *counts* the daemon reports — `tokens_before`, `tokens_after`, `tokens_source`,
 * `window_tokens` — are measurements, not credentials. `DEFAULT_REDACT_FIELDS` drops any field
 * whose name contains `token`, which silently removed them from every compaction line (task #16:
 * lines on 0.1.28 carried neither a count nor a reason). This list keeps the library's protections
 * and narrows only that one pattern: a field is redacted for containing `token` unless its whole
 * name is one of the known counters, so `token`, `access_token` and `tokens_key` are still dropped. */
const TOKEN_COUNTER_NAMES = String.raw`(?:window_)?tokens(?:_(?:before|after|source|after_unavailable|used|limit))?`;
const REDACT_FIELDS: FieldPattern[] = [
  ...DEFAULT_REDACT_FIELDS.filter(
    (pattern) => !(pattern instanceof RegExp && pattern.source === "token"),
  ),
  new RegExp(String.raw`^(?!${TOKEN_COUNTER_NAMES}$).*token`, "i"),
  /^authorization$/i,
  /^body$/i,
  /^cookie$/i,
  /^message_body$/i,
  /^prompt$/i,
  /^secret$/i,
];

/** Shared sink configuration, called once by each Daemon-role entrypoint. */
export async function configureDaemonLogging(stateDirectory: string): Promise<void> {
  const logPath = await prepareDaemonLogFile(stateDirectory);
  await configure({
    reset: true,
    sinks: {
      daemon: redactByField(
        getRotatingFileSink(logPath, {
          maxSize: 10 * 1024 * 1024,
          maxFiles: 5,
          // Flush every record. The sync sink has no timer: with a buffer it writes only when the
          // buffer fills or when a *later* record arrives a whole flushInterval after the last
          // flush, so a daemon's startup lines and a quiet Workspace's request lines sat in memory
          // until the process exited (a cloud Computer looked like it wrote no logs at all).
          bufferSize: 0,
          formatter: getJsonLinesFormatter({ properties: "flatten" }),
        }),
        {
          fieldPatterns: REDACT_FIELDS,
        },
      ),
    },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["daemon"] },
      { category: ["logtape", "meta"], lowestLevel: "error" },
    ],
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
  });
  markStartup("logging");
}
