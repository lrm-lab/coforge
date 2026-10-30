import { expect, test } from "bun:test";
import {
  recordServerFnError,
  withServerFnLog,
} from "#src/server/observability/server-fn-log.server";

// Each server function call leaves one line; a slow, failed or never-ending one a warning.
const ID = "2b1ffd41823676ba3e046da81e6f54d015758e0966517222d5e07f29bee93dbf";
const request = (init?: RequestInit) =>
  new Request(`https://coforge.test/_serverFn/${ID}?payload=1`, init);
const ok = () => ({ response: new Response("{}", { status: 200 }) });

function recorder() {
  const lines: { level: string; line: Record<string, unknown> }[] = [];
  const log = {
    info: (line: string) => lines.push({ level: "info", line: JSON.parse(line) }),
    warn: (line: string) => lines.push({ level: "warn", line: JSON.parse(line) }),
  };
  return { lines, log };
}

test("a quick call is one info line with its id, method, status and time", async () => {
  const { lines, log } = recorder();
  let clock = 0;
  await withServerFnLog(
    request({ headers: { "x-request-id": "req-1" } }),
    () => {
      clock = 42;
      return ok();
    },
    { log, now: () => clock },
  );
  expect(lines).toEqual([
    {
      level: "info",
      line: {
        event: "server_fn.finished",
        fn: ID,
        method: "GET",
        request_id: "req-1",
        status: 200,
        duration_ms: 42,
      },
    },
  ]);
});

test("a call still running past the threshold is reported then, and warned when it ends", async () => {
  const { lines, log } = recorder();
  await withServerFnLog(
    request(),
    async () => {
      await Bun.sleep(150);
      return ok();
    },
    { log, slowMs: 20 },
  );
  expect(lines.map(({ level, line }) => [level, line.event])).toEqual([
    ["warn", "server_fn.running"],
    ["warn", "server_fn.finished"],
  ]);
});

test("a function that threw answers normally but is warned with its error", async () => {
  const { lines, log } = recorder();
  await withServerFnLog(
    request(),
    () => {
      recordServerFnError(new TypeError("boom"));
      return ok();
    },
    { log },
  );
  expect(lines).toEqual([
    {
      level: "warn",
      line: expect.objectContaining({ status: 200, error_type: "TypeError" }),
    },
  ]);
});

test("a call that fails, or that the browser abandoned, is a warning and still throws", async () => {
  const { lines, log } = recorder();
  const abandoned = new AbortController();
  abandoned.abort();
  for (const sent of [request(), request({ signal: abandoned.signal })])
    await expect(
      withServerFnLog(
        sent,
        () => {
          throw new TypeError("boom");
        },
        { log },
      ),
    ).rejects.toThrow("boom");
  expect(lines.map(({ level, line }) => [level, line.event, line.error_type])).toEqual([
    ["warn", "server_fn.failed", "TypeError"],
    ["warn", "server_fn.aborted", "TypeError"],
  ]);
});

test("a server error response is a warning", async () => {
  const { lines, log } = recorder();
  await withServerFnLog(request(), () => ({ response: new Response("", { status: 500 }) }), {
    log,
  });
  expect(lines[0]?.level).toBe("warn");
});
