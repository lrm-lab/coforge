import { readLines } from "../../../../scripts/test/read-lines";

const threadId = "thread-compatible";
const turnId = "turn-compatible";
const nativeProvider = process.argv
  .find((arg) => /^model_provider="(?:coforge-)?openai-compatible"$/.test(arg))
  ?.split('"')[1];
const compatible = nativeProvider !== undefined;
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

for await (const line of readLines(Bun.stdin.stream())) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line) as {
    id?: string;
    method: string;
    params?: { cwds?: string[] };
  };
  if (!id) continue;

  switch (method) {
    case "initialize":
      write({ id, result: { userAgent: "coforge_daemon/0.169.0 (Mac OS 15.6; arm64) fixture" } });
      break;
    case "skills/list":
      write({ id, result: { data: (params?.cwds ?? []).map((cwd) => ({ cwd, errors: [] })) } });
      break;
    case "thread/start":
      write({
        id,
        result: {
          thread: { id: threadId },
          modelProvider: nativeProvider ?? "openai",
        },
      });
      break;
    case "thread/resume":
      if (process.argv.includes("same-provider")) {
        write({
          id,
          result: { thread: { id: "old-thread" }, modelProvider: "coforge-openai-compatible" },
        });
      } else if (compatible) {
        write({ id, result: { thread: { id: "old-thread" }, modelProvider: "openai" } });
      } else {
        write({
          id,
          error: {
            code: -32600,
            message:
              "This chat uses model provider “coforge-openai-compatible”, which is no longer configured. Restore this provider’s configuration to continue.",
          },
        });
      }
      break;
    case "turn/start": {
      const error = {
        message: "Requests per minute exceeded",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      };
      write({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      write({
        method: "turn/started",
        params: { threadId, turn: { id: turnId, status: "inProgress" } },
      });
      write({ method: "error", params: { threadId, turnId, willRetry: false, error } });
      write({
        method: "thread/status/changed",
        params: { threadId, status: { type: "systemError" } },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "failed", error } },
      });
      break;
    }
    default:
      throw new Error(`Unexpected method: ${method}`);
  }
}
