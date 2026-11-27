import {
  decideTerminalAttach,
  isCurrentTerminalAttach,
} from "@lrm/coforge-sdk/internal/computer-terminal-replay";
import type {
  ComputerTerminalControl,
  ComputerTerminalFrame,
  TerminalScope,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import { ComputerTerminalOutput } from "./computer-terminal-output";

type Dimensions = { cols: number; rows: number };
type OpenRequest = Dimensions & { takeover: boolean };
type ShellExit = { code: number; signal: string | null };
type TerminalPty = {
  shellKind: string;
  shellExited: Promise<ShellExit>;
  write(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
};
type TerminalOptions = Pick<TerminalScope, "workspaceId" | "computerId" | "ownerUserId"> & {
  daemonInstanceId: string;
  spawn(dimensions: Dimensions, onOutput: (bytes: Uint8Array) => void): Promise<TerminalPty>;
  emit(frame: ComputerTerminalFrame): boolean;
  canReplay?(size: ComputerTerminalOutput["snapshotSize"]): boolean;
};
type TerminalLease = OpenRequest & {
  scope: TerminalScope;
  active: boolean;
  opened: boolean;
  nextInputSeq: number;
};
type ActiveSession = {
  output: ComputerTerminalOutput;
  dimensions: Dimensions;
  lease: TerminalLease;
  startup: Promise<TerminalPty>;
  closing?: Promise<void>;
  draining?: boolean;
  writing?: TerminalLease;
};
type TerminalEvent = ComputerTerminalFrame["event"];

function leaseFor(scope: TerminalScope, request: OpenRequest): TerminalLease {
  return { ...request, scope, active: true, opened: false, nextInputSeq: 1 };
}

export class ComputerTerminalSession {
  #session: ActiveSession | undefined;
  #closedSessions = new Set<string>();
  #stopped = false;

  constructor(private readonly options: TerminalOptions) {}

  async control({ command, ...scope }: ComputerTerminalControl): Promise<void> {
    if (
      this.#stopped ||
      scope.workspaceId !== this.options.workspaceId ||
      scope.computerId !== this.options.computerId ||
      scope.ownerUserId !== this.options.ownerUserId
    )
      return;

    if (command.case === "openOrAttach") {
      await this.#open(scope, command.value);
      return;
    }
    const session = this.#session;
    const lease = session?.lease;
    if (!session || !lease || !lease.active || !isCurrentTerminalAttach(lease.scope, scope)) return;
    if (command.case === "detach") {
      lease.active = false;
      return;
    }
    if (command.case === "close") {
      await this.#close(session, "closed");
      return;
    }
    if (!lease.opened || session.closing) return;
    const pty = await session.startup;
    if (!lease.active || session.lease !== lease || session.closing) return;
    if (command.case === "resize") {
      this.#resize(session, pty, command.value);
    } else {
      await this.#input(session, lease, pty, command.value);
    }
  }

  suspendAttachment(scope: TerminalScope): void {
    const lease = this.#session?.lease;
    if (lease && isCurrentTerminalAttach(lease.scope, scope)) lease.active = false;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#session) await this.#close(this.#session, "closed");
  }

  async #open(scope: TerminalScope, request: OpenRequest): Promise<void> {
    if (this.#closedSessions.has(scope.sessionId)) return;

    let session = this.#session;
    if (!session) {
      const startup = Promise.resolve().then(() =>
        this.options.spawn(request, (bytes) => this.#output(created, bytes)),
      );
      const created: ActiveSession = {
        startup,
        output: new ComputerTerminalOutput(),
        dimensions: request,
        lease: leaseFor(scope, request),
      };
      session = created;
      this.#session = created;
      void startup
        .then(
          (pty) =>
            pty.shellExited.then(
              (exit) => this.#close(created, "exited", exit),
              () => this.#close(created, "daemon_replaced"),
            ),
          () => {},
        )
        .catch(() => {});
    } else {
      const { lease } = session;
      if (session.closing || scope.sessionId !== lease.scope.sessionId) {
        this.options.emit({ ...scope, event: { case: "error", value: { code: "capacity" } } });
        return;
      }
      const action = decideTerminalAttach({ ...lease.scope, ...lease }, { ...scope, ...request });
      if (action === "attach_conflict") {
        this.options.emit({ ...scope, event: { case: "error", value: { code: action } } });
      }
      if (action !== "replace") return;
      session.lease = leaseFor(scope, request);
    }

    const lease = session.lease;
    let pty: TerminalPty;
    try {
      pty = await session.startup;
    } catch {
      if (session.lease === lease && lease.active) {
        this.options.emit({ ...scope, event: { case: "error", value: { code: "spawn_failed" } } });
      }
      await this.#close(session, "closed");
      return;
    }
    if (!lease.active || session.lease !== lease || session.closing) return;
    this.#resize(session, pty, request);
    const historyUnavailable =
      session.output.historyUnavailable ||
      this.options.canReplay?.(session.output.snapshotSize) === false;
    const opened = this.#send(session, {
      case: "opened",
      value: {
        daemonInstanceId: this.options.daemonInstanceId,
        shellKind: pty.shellKind,
        ...session.dimensions,
        nextOutputSeq: session.output.nextOutputSeq,
        historyUnavailable,
      },
    });
    if (!opened) return;
    if (!historyUnavailable) {
      for (const snapshot of session.output.snapshot()) {
        if (!this.#send(session, { case: "snapshot", value: snapshot })) return;
      }
    }
    lease.opened = true;
  }

  #resize(session: ActiveSession, pty: TerminalPty, { cols, rows }: Dimensions): void {
    if (session.dimensions.cols === cols && session.dimensions.rows === rows) return;
    pty.resize(cols, rows);
    session.dimensions = { cols, rows };
    session.output.resized();
  }

  async #input(
    session: ActiveSession,
    lease: TerminalLease,
    pty: TerminalPty,
    { inputSeq, bytes }: { inputSeq: number; bytes: Uint8Array },
  ): Promise<void> {
    if (inputSeq < lease.nextInputSeq) {
      this.#send(session, { case: "inputAccepted", value: { inputSeq } });
      return;
    }
    if (inputSeq === lease.nextInputSeq && session.writing === lease) return;
    if (inputSeq !== lease.nextInputSeq || session.writing) {
      this.#send(session, { case: "error", value: { code: "input_sequence" } });
      return;
    }
    session.writing = lease;
    try {
      await pty.write(bytes);
      lease.nextInputSeq++;
      if (session.lease === lease && lease.active && !session.closing) {
        this.#send(session, { case: "inputAccepted", value: { inputSeq } });
      }
    } catch {
      if (!session.closing) await this.#close(session, "closed");
    } finally {
      session.writing = undefined;
    }
  }

  #output(session: ActiveSession, bytes: Uint8Array): void {
    if (this.#session !== session) return;
    for (const chunk of session.output.append(bytes)) {
      if (session.output.nextOutputSeq > 0xffff_ffff) {
        this.options.emit({
          ...session.lease.scope,
          event: { case: "error", value: { code: "capacity" } },
        });
        void this.#close(session, "closed").catch(() => {});
        return;
      }
      if (
        session.lease.active &&
        session.lease.opened &&
        (!session.closing || session.draining) &&
        !this.#send(session, { case: "output", value: chunk })
      )
        return;
    }
  }

  #send(session: ActiveSession, event: TerminalEvent): boolean {
    const { scope } = session.lease;
    if (this.options.emit({ ...scope, event })) return true;
    this.options.emit({
      ...scope,
      event: { case: "error", value: { code: "output_backpressure" } },
    });
    void this.#close(session, "output_backpressure").catch(() => {});
    return false;
  }

  #close(session: ActiveSession, reason: string, exit?: ShellExit): Promise<void> {
    if (session.closing) return session.closing;
    session.draining = exit !== undefined;
    session.closing = session.startup
      .then(
        (pty) => pty.close(),
        () => {},
      )
      .then(() => {
        const { scope, active, opened } = session.lease;
        this.#closedSessions.add(scope.sessionId);
        this.#session = undefined;
        if (!active || !opened) return;
        if (exit) {
          const status = exit.signal
            ? { case: "signal" as const, value: exit.signal }
            : { case: "code" as const, value: exit.code };
          this.options.emit({ ...scope, event: { case: "exit", value: { status } } });
        }
        this.options.emit({ ...scope, event: { case: "closed", value: { reason } } });
      });
    return session.closing;
  }
}
