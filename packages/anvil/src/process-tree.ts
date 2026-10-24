/** Child process capabilities exposed by the daemon's platform implementation. */
export interface OwnedChildProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stdin: { write(value: string): boolean; end(): void; flush(): Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  kill(signal?: "SIGINT" | "SIGKILL" | "SIGTERM"): void;
}

export interface OwnedProcessTree {
  readonly child: OwnedChildProcess;
  terminate(force: boolean): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export type ProcessCommandRunner = (command: readonly string[]) => Promise<void>;

export interface ProcessTreeSpawner {
  spawn(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ): OwnedProcessTree;
}
