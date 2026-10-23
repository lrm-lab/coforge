import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Record shapes observed in Claude Code 2.1.309 session transcripts (`<configDir>/projects`). */
export type Usage = { input: number; cacheRead: number; cacheCreate: number };

export function assistantRecord(options: {
  timestamp: string;
  usage?: Usage;
  content?: unknown[];
  isSidechain?: boolean;
}): string {
  const { usage } = options;
  return JSON.stringify({
    type: "assistant",
    timestamp: options.timestamp,
    isSidechain: options.isSidechain ?? false,
    message: {
      role: "assistant",
      content: options.content ?? [{ type: "text", text: "ok" }],
      ...(usage
        ? {
            usage: {
              input_tokens: usage.input,
              cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheCreate,
            },
          }
        : {}),
    },
  });
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id, name, input };
}

export function toolUseRecord(
  timestamp: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return assistantRecord({ timestamp, content: [toolUse(id, name, input)] });
}

export function toolResultRecord(
  timestamp: string,
  id: string,
  content: string | unknown[],
  isError = false,
): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });
}

/** A temporary Claude config directory; `transcript` writes `projects/<project>/<id>.jsonl`. */
export async function claudeConfigFixture() {
  const configDir = await mkdtemp(join(tmpdir(), "coforge-claude-config-"));
  return {
    configDir,
    envVars: { CLAUDE_CONFIG_DIR: configDir },
    async transcript(sessionId: string, lines: readonly string[], project = "-work-project") {
      const path = join(configDir, "projects", project, `${sessionId}.jsonl`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${lines.join("\n")}\n`);
      return path;
    },
    remove: () => rm(configDir, { recursive: true, force: true }),
  };
}
