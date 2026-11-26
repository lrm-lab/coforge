import {
  PROC_LOGS_FOLLOW_MAX_MS,
  PROC_LOGS_MAX_TAIL,
  PROC_NAME_PATTERN,
  type AgentProcListResponse,
  type AgentProcLogsRequest,
  type AgentProcLogsResponse,
  type AgentProcStartRequest,
  type AgentProcStartResponse,
  type AgentProcStopRequest,
  type AgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";
import { invalidArgument, unknownCommandError } from "#src/command-help/index";
import { CliError, withOutputMode } from "#src/cli-error";
import { cliFlagBadToken, parseCliFlags } from "./cli-flags";
import type { MessageTransport } from "#src/message-transport";
import { formatProcList, formatProcLogs, formatProcStart, formatProcStop } from "./proc-format";

export type ProcInvocation =
  | {
      command: "proc";
      operation: "start";
      name?: string;
      cwd?: string;
      env?: Record<string, string>;
      commandArgs: string[];
      json?: boolean;
    }
  | {
      command: "proc";
      operation: "list";
      json?: boolean;
    }
  | {
      command: "proc";
      operation: "logs";
      name: string;
      tail?: number;
      follow?: boolean;
      json?: boolean;
    }
  | {
      command: "proc";
      operation: "stop";
      name?: string;
      all?: boolean;
      force?: boolean;
      json?: boolean;
    };

function requireFlagValue(
  args: readonly string[],
  index: number,
  command: string,
  flag: string,
  json: boolean,
): string {
  const value = args[index + 1];
  if (value === undefined)
    throw withOutputMode(
      invalidArgument(command, `${flag} needs a value.`),
      json ? "json" : "text",
    );
  return value;
}

function parseStartArgs(args: readonly string[]): ProcInvocation {
  const dashDash = args.indexOf("--");
  const json = (dashDash === -1 ? args : args.slice(0, dashDash)).includes("--json");
  let name: string | undefined;
  let cwd: string | undefined;
  const envEntries: [string, string][] = [];
  let commandArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      commandArgs = args.slice(index + 1);
      break;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg === "--name") {
      name = requireFlagValue(args, index++, "proc start", "--name", json);
      if (!PROC_NAME_PATTERN.test(name))
        throw withOutputMode(
          invalidArgument("proc start", "--name must be 1-40 chars matching [A-Za-z0-9_-]."),
          json ? "json" : "text",
        );
      continue;
    }
    if (arg === "--cwd") {
      cwd = requireFlagValue(args, index++, "proc start", "--cwd", json);
      continue;
    }
    if (arg === "--env") {
      const pair = requireFlagValue(args, index++, "proc start", "--env", json);
      const equals = pair.indexOf("=");
      if (equals <= 0)
        throw withOutputMode(
          invalidArgument("proc start", "--env must be KEY=VALUE with a non-empty key."),
          json ? "json" : "text",
        );
      envEntries.push([pair.slice(0, equals), pair.slice(equals + 1)]);
      continue;
    }
    if (arg.startsWith("-")) {
      throw withOutputMode(
        invalidArgument("proc start", `Unknown argument "${arg}".`),
        json ? "json" : "text",
      );
    }
    commandArgs = args.slice(index);
    break;
  }

  if (commandArgs.length === 0 || !commandArgs[0]?.trim())
    throw withOutputMode(
      invalidArgument("proc start", "A command is required after options or `--`."),
      json ? "json" : "text",
    );

  return {
    command: "proc",
    operation: "start",
    ...(name !== undefined ? { name } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    commandArgs,
    ...(json ? { json: true as const } : {}),
  };
}

function parseListArgs(args: readonly string[]): ProcInvocation {
  const json = args.includes("--json");
  const { values } = parseCliFlags({
    args,
    options: { json: { type: "boolean" } },
    onError(error) {
      throw withOutputMode(
        invalidArgument("proc list", `Unknown argument "${cliFlagBadToken(error)}".`),
        json ? "json" : "text",
      );
    },
  });
  return { command: "proc", operation: "list", ...(values.json ? { json: true as const } : {}) };
}

function parseLogsArgs(args: readonly string[]): ProcInvocation {
  const json = args.includes("--json");
  const { values, positionals } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      follow: { type: "boolean" },
      tail: { type: "string" },
    },
    maxPositionals: 1,
    onError(error) {
      if (error.kind === "missing-value")
        throw withOutputMode(
          invalidArgument("proc logs", `${error.flag} needs a value.`),
          json ? "json" : "text",
        );
      if (error.kind === "unexpected-positional")
        throw withOutputMode(
          invalidArgument("proc logs", `Unexpected argument "${error.value}".`),
          json ? "json" : "text",
        );
      throw withOutputMode(
        invalidArgument("proc logs", `Unknown argument "${cliFlagBadToken(error)}".`),
        json ? "json" : "text",
      );
    },
  });
  let tail: number | undefined;
  if (values.tail !== undefined) {
    const parsed = Number(values.tail);
    if (!/^\d+$/.test(values.tail) || !Number.isSafeInteger(parsed) || parsed > PROC_LOGS_MAX_TAIL)
      throw withOutputMode(
        invalidArgument("proc logs", `--tail must be an integer from 0 to ${PROC_LOGS_MAX_TAIL}.`),
        json ? "json" : "text",
      );
    tail = parsed;
  }
  const name = positionals[0];
  if (!name || !PROC_NAME_PATTERN.test(name))
    throw withOutputMode(
      invalidArgument("proc logs", "A valid job <name> is required."),
      json ? "json" : "text",
    );
  return {
    command: "proc",
    operation: "logs",
    name,
    ...(tail !== undefined ? { tail } : {}),
    ...(values.follow ? { follow: true as const } : {}),
    ...(values.json ? { json: true as const } : {}),
  };
}

function parseStopArgs(args: readonly string[]): ProcInvocation {
  const json = args.includes("--json");
  const { values, positionals } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      all: { type: "boolean" },
      force: { type: "boolean" },
    },
    maxPositionals: 1,
    onError(error) {
      if (error.kind === "unexpected-positional")
        throw withOutputMode(
          invalidArgument("proc stop", `Unexpected argument "${error.value}".`),
          json ? "json" : "text",
        );
      throw withOutputMode(
        invalidArgument("proc stop", `Unknown argument "${cliFlagBadToken(error)}".`),
        json ? "json" : "text",
      );
    },
  });
  const name = positionals[0];
  const all = values.all === true;
  if ((name !== undefined && all) || (name === undefined && !all))
    throw withOutputMode(
      invalidArgument("proc stop", "Specify either a job <name> or --all, not both."),
      json ? "json" : "text",
    );
  if (name !== undefined && !PROC_NAME_PATTERN.test(name))
    throw withOutputMode(invalidArgument("proc stop", "Invalid job name."), json ? "json" : "text");
  return {
    command: "proc",
    operation: "stop",
    ...(name !== undefined ? { name } : {}),
    ...(all ? { all: true as const } : {}),
    ...(values.force ? { force: true as const } : {}),
    ...(values.json ? { json: true as const } : {}),
  };
}

export function parseProcArgs(args: readonly string[]): ProcInvocation {
  const operation = args[0];
  if (operation === "start") return parseStartArgs(args.slice(1));
  if (operation === "list") return parseListArgs(args.slice(1));
  if (operation === "logs") return parseLogsArgs(args.slice(1));
  if (operation === "stop") return parseStopArgs(args.slice(1));
  throw unknownCommandError(["proc", ...args]);
}

type ProcTransport = Pick<MessageTransport, "procList" | "procStart" | "procLogs" | "procStop">;

async function followProcLogs(
  procLogs: (request: AgentProcLogsRequest) => Promise<AgentProcLogsResponse>,
  name: string,
  tail: number | undefined,
): Promise<AgentProcLogsResponse> {
  const deadline = Date.now() + PROC_LOGS_FOLLOW_MAX_MS;
  let last = await procLogs({ name, ...(tail !== undefined ? { tail } : {}) });
  const chunks = last.content ? [last.content] : [];
  let rotated = last.rotated;
  let truncated = last.truncated;

  while (last.job.status === "running" && Date.now() < deadline) {
    await Bun.sleep(Math.min(500, Math.max(10, deadline - Date.now())));
    if (Date.now() > deadline) break;
    last = await procLogs({ name, offset: last.nextOffset });
    if (last.rotated) rotated = true;
    if (last.truncated) truncated = true;
    if (last.content) chunks.push(last.content);
  }
  return {
    ...last,
    content: chunks.join(""),
    rotated,
    truncated,
  };
}

export async function runProcCommand(
  invocation: ProcInvocation,
  transport: ProcTransport,
): Promise<string> {
  try {
    if (invocation.operation === "list") {
      if (!transport.procList) throw new Error("Proc list transport is unavailable");
      const response: AgentProcListResponse = await transport.procList();
      return invocation.json ? JSON.stringify(response) : formatProcList(response);
    }
    if (invocation.operation === "start") {
      if (!transport.procStart) throw new Error("Proc start transport is unavailable");
      const request: AgentProcStartRequest = {
        command: invocation.commandArgs,
        ...(invocation.name !== undefined ? { name: invocation.name } : {}),
        ...(invocation.cwd !== undefined ? { cwd: invocation.cwd } : {}),
        ...(invocation.env !== undefined ? { env: invocation.env } : {}),
      };
      const response: AgentProcStartResponse = await transport.procStart(request);
      return invocation.json ? JSON.stringify(response) : formatProcStart(response);
    }
    if (invocation.operation === "logs") {
      if (!transport.procLogs) throw new Error("Proc logs transport is unavailable");
      const response = invocation.follow
        ? await followProcLogs(transport.procLogs, invocation.name, invocation.tail)
        : await transport.procLogs({
            name: invocation.name,
            ...(invocation.tail !== undefined ? { tail: invocation.tail } : {}),
          });
      return invocation.json ? JSON.stringify(response) : formatProcLogs(response);
    }
    if (!transport.procStop) throw new Error("Proc stop transport is unavailable");
    const request: AgentProcStopRequest = {
      ...(invocation.name !== undefined ? { name: invocation.name } : {}),
      ...(invocation.all ? { all: true } : {}),
      ...(invocation.force ? { force: true } : {}),
    };
    const response: AgentProcStopResponse = await transport.procStop(request);
    return invocation.json ? JSON.stringify(response) : formatProcStop(response);
  } catch (error) {
    if (error instanceof CliError) throw withOutputMode(error, invocation.json ? "json" : "text");
    throw error;
  }
}
