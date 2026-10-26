import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { OwnedProcessTree, ProcessTreeSpawner } from "#src/process-tree";
import type { ClaudeAuthProcessFactory } from "./auth";

export interface ClaudeReplyIntentScanner {
  feed(delta: {
    callId: string;
    fragment: string;
  }): Extract<AgentRuntimeEvent, { type: "reply-intent" }> | undefined;
  complete(callId: string): void;
  reset(): string[];
}

export interface ClaudeTurnHost {
  createReplyIntentScanner(): ClaudeReplyIntentScanner;
  isShellToolName(name: string): boolean;
}

/** One code-agent session's system-prompt file, and the removal of the directory holding it. */
export type ClaudePromptFile = {
  /** The path to pass to the code agent as its appended system prompt. */
  readonly path: string;
  /**
   * Removes the directory. A session asks more than once - when its process closes, and again
   * when it is disposed - and the two used to be separate recursive removes walking the same
   * directory at once, which on macOS failed the second one with EPERM (`force` suppresses a
   * missing path, not a directory that vanishes mid-walk), so disposing a session that had
   * exited normally threw. Every call now waits on the same single removal.
   */
  remove(): Promise<void>;
};

export interface ClaudeSessionHost extends ClaudeTurnHost {
  readonly processTreeSpawner: ProcessTreeSpawner;
  buildSessionEnvironment(options: AgentSessionOptions): {
    environment: Record<string, string>;
    autoCompactWindow: number | undefined;
  };
  createPromptFile(instructions: string): Promise<ClaudePromptFile>;
}

export type ClaudeCliRunResult = {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
};

export interface ClaudeUsageHost {
  buildUsageEnvironment(environment?: Readonly<Record<string, string>>): Record<string, string>;
  runCli(
    command: readonly string[],
    cwd: string,
    environment: Record<string, string>,
    timeoutMs: number,
  ): Promise<ClaudeCliRunResult>;
  spawnUsageProcess(
    command: readonly string[],
    cwd: string,
    environment: Record<string, string>,
  ): OwnedProcessTree;
  /** The native probe remembers a successful boolean at its original interpretation point. */
  withUsageCapabilityCache(
    command: readonly string[],
    cwd: string,
    environment: Record<string, string>,
    load: (remember: (supported: boolean) => void) => Promise<boolean>,
  ): Promise<boolean>;
  maskAccountLabel(value: string): string | undefined;
}

export interface ClaudeDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

export interface ClaudeFileInfo {
  readonly mtimeMs: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Native history layout and traversal stay in the driver; actual I/O stays with the host. */
export interface ClaudeHistoryHost {
  readHostEnvironment(name: "CLAUDE_CONFIG_DIR" | "HOME"): string | undefined;
  homeDirectory(): string;
  readDirectoryEntries(path: string): Promise<readonly ClaudeDirectoryEntry[]>;
  readDirectoryNames(path: string): Promise<readonly string[]>;
  lstat(path: string): Promise<ClaudeFileInfo>;
  readFileTail(path: string, tailBytes: number): Promise<{ text: string; startOffset: number }>;
}

export interface ClaudeBriefingHost extends ClaudeHistoryHost {
  realWorkspaceRoot(root: string): Promise<string | null>;
  rereadFile(path: string, realRoot: string | null): Promise<string | null>;
}

export interface ClaudeRuntimeHost extends ClaudeSessionHost, ClaudeUsageHost, ClaudeBriefingHost {}

export interface ClaudeAuthHost {
  buildAuthEnvironment(): Record<string, string>;
  readonly createAuthProcess: ClaudeAuthProcessFactory;
  maskAccountLabel(value: string): string | undefined;
}
