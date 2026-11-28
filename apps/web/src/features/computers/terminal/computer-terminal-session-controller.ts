import {
  isCurrentTerminalAttach,
  TerminalSnapshotReplay,
} from "@lrm/coforge-sdk/internal/computer-terminal-replay";
import {
  decodeTerminalFrame,
  type ComputerTerminalFrame,
  type TerminalScope,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import type { TokenizedRealtimeOptions } from "#src/features/realtime/browser-realtime";
import type {
  PrepareTerminalAttachResult,
  SendTerminalInputResult,
} from "#src/server/computers/computer-terminal.server";
import type { TerminalAttachMode } from "#src/server/computers/computer-terminal-store.server";
import {
  encodeBytesBase64,
  TerminalInputQueue,
  type ComputerTerminalStatusResult,
  type TerminalNotice,
  type TerminalUiStatus,
} from "./computer-terminal-state";

export type ComputerTerminalControllerState = {
  status: TerminalUiStatus;
  mode: TerminalAttachMode;
  shellKind: string | null;
  dimensions: { cols: number; rows: number } | null;
  notice: TerminalNotice | null;
};

export type ComputerTerminalControllerTransport = {
  prepareAttach(input: {
    computerId: string;
    cols: number;
    rows: number;
    takeover: boolean;
    mode: TerminalAttachMode;
  }): Promise<PrepareTerminalAttachResult>;
  activateAttach(input: {
    computerId: string;
    sessionId: string;
    attachId: string;
    attachGeneration: number;
    cols: number;
    rows: number;
    takeover: boolean;
  }): Promise<unknown>;
  refreshSubscription(input: {
    computerId: string;
    sessionId: string;
    attachId: string;
    attachGeneration: number;
  }): Promise<{ token: string; channel: string; expiresAtMs: number }>;
  sendInput(input: {
    computerId: string;
    sessionId: string;
    attachId: string;
    attachGeneration: number;
    inputSeq: number;
    dataBase64: string;
  }): Promise<SendTerminalInputResult>;
  resize(input: {
    computerId: string;
    sessionId: string;
    attachId: string;
    attachGeneration: number;
    cols: number;
    rows: number;
  }): Promise<unknown>;
  detach(input: {
    computerId: string;
    sessionId: string;
    attachId: string;
    attachGeneration: number;
  }): Promise<unknown>;
  close(input: {
    computerId: string;
    sessionId?: string;
    attachId?: string;
    attachGeneration?: number;
  }): Promise<unknown>;
  readStatus(input: { computerId: string }): Promise<ComputerTerminalStatusResult>;
  subscribeTokenized(options: TokenizedRealtimeOptions): () => void;
};

const OPEN_TIMEOUT_MS = 8_000;

export class ComputerTerminalSessionController {
  private attemptCounter = 0;
  private activeScope: TerminalScope | null = null;
  private activeMode: TerminalAttachMode = "interactive";
  private replay: TerminalSnapshotReplay | null = null;
  private unsubscribeChannel: (() => void) | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private hasSubscribed = false;
  private exitNotice: TerminalNotice | null = null;
  private disposed = false;
  private state: ComputerTerminalControllerState;
  private readonly inputQueue: TerminalInputQueue;
  private readonly openTimeoutMs: number;

  constructor(
    private readonly options: {
      computerId: string;
      transport: ComputerTerminalControllerTransport;
      onStateChange: (state: ComputerTerminalControllerState) => void;
      onOutput: (bytes: Uint8Array) => void;
      onResetOutput?: () => void;
      openTimeoutMs?: number;
    },
  ) {
    this.openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    this.state = {
      status: "disconnected",
      mode: "interactive",
      shellKind: null,
      dimensions: null,
      notice: null,
    };
    this.inputQueue = new TerminalInputQueue({
      send: (inputSeq, bytes) => {
        const scope = this.activeScope;
        if (!scope || this.activeMode !== "interactive" || this.state.status !== "connected") {
          return Promise.reject(new Error("Terminal is not attached"));
        }
        return this.options.transport.sendInput({
          computerId: this.options.computerId,
          sessionId: scope.sessionId,
          attachId: scope.attachId,
          attachGeneration: scope.attachGeneration,
          inputSeq,
          dataBase64: encodeBytesBase64(bytes),
        });
      },
      onFailure: () => {
        void this.handleUnexpectedDisconnect();
      },
      onSequenceMismatch: () => {
        void this.handleUnexpectedDisconnect();
      },
    });
  }

  get currentState(): ComputerTerminalControllerState {
    return this.state;
  }

  async connect(input: {
    cols: number;
    rows: number;
    takeover: boolean;
    mode: TerminalAttachMode;
  }): Promise<void> {
    if (this.disposed) return;
    const attempt = ++this.attemptCounter;
    const previousScope = this.activeScope;
    this.cleanupActiveAttach();
    if (previousScope) {
      void this.options.transport
        .detach({
          computerId: this.options.computerId,
          sessionId: previousScope.sessionId,
          attachId: previousScope.attachId,
          attachGeneration: previousScope.attachGeneration,
        })
        .catch(() => {});
    }

    this.activeMode = input.mode;
    this.emitState({
      status: "connecting",
      mode: input.mode,
      shellKind: null,
      dimensions: null,
      notice: null,
    });

    let prepared: PrepareTerminalAttachResult;
    try {
      prepared = await this.options.transport.prepareAttach({
        computerId: this.options.computerId,
        cols: input.cols,
        rows: input.rows,
        takeover: input.takeover,
        mode: input.mode,
      });
    } catch {
      if (attempt !== this.attemptCounter || this.disposed) return;
      await this.resolvePostDisconnectStatus(attempt);
      return;
    }

    if (attempt !== this.attemptCounter || this.disposed) return;
    if (prepared.status === "attach_conflict") {
      this.emitState({
        status: "disconnected",
        mode: input.mode,
        shellKind: null,
        dimensions: null,
        notice: { kind: "conflict" },
      });
      return;
    }

    const scope = prepared.scope;
    this.activeScope = scope;
    this.activeMode = prepared.mode;
    this.hasSubscribed = false;
    let activated = false;

    const startTimeout = () => {
      this.clearOpenTimer();
      this.openTimer = setTimeout(() => {
        if (attempt !== this.attemptCounter || this.state.status === "connected") return;
        void this.handleUnexpectedDisconnect(attempt);
      }, this.openTimeoutMs);
    };
    startTimeout();

    this.unsubscribeChannel = this.options.transport.subscribeTokenized({
      channel: prepared.channel,
      token: prepared.subscriptionToken,
      getToken: async () => {
        const refreshed = await this.options.transport.refreshSubscription({
          computerId: this.options.computerId,
          sessionId: scope.sessionId,
          attachId: scope.attachId,
          attachGeneration: scope.attachGeneration,
        });
        return refreshed.token;
      },
      onSubscribed: () => {
        if (attempt !== this.attemptCounter || this.disposed) return;
        this.hasSubscribed = true;
        if (activated) return;
        activated = true;
        void this.options.transport
          .activateAttach({
            computerId: this.options.computerId,
            sessionId: scope.sessionId,
            attachId: scope.attachId,
            attachGeneration: scope.attachGeneration,
            cols: prepared.cols,
            rows: prepared.rows,
            takeover: input.takeover,
          })
          .catch(() => {
            if (attempt !== this.attemptCounter || this.disposed) return;
            void this.handleUnexpectedDisconnect(attempt);
          });
      },
      onSubscribing: () => {
        if (attempt !== this.attemptCounter || this.disposed) return;
        if (this.hasSubscribed) {
          void this.handleUnexpectedDisconnect(attempt);
        }
      },
      onPublication: (publication) => {
        if (attempt !== this.attemptCounter || this.disposed) return;
        if (!(publication.data instanceof Uint8Array)) return;
        this.handleBinaryFrame(attempt, scope, publication.data);
      },
      onUnsubscribed: () => {
        if (attempt !== this.attemptCounter || this.disposed) return;
        if (this.activeScope?.attachId === scope.attachId) {
          void this.handleUnexpectedDisconnect(attempt);
        }
      },
      onError: () => {
        if (attempt !== this.attemptCounter || this.disposed) return;
        if (this.activeScope?.attachId === scope.attachId) {
          void this.handleUnexpectedDisconnect(attempt);
        }
      },
    });
  }

  sendText(text: string): void {
    if (this.disposed || this.activeMode === "readonly" || this.state.status !== "connected")
      return;
    this.inputQueue.enqueue(text);
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (
      this.disposed ||
      this.activeMode === "readonly" ||
      this.state.status !== "connected" ||
      !this.activeScope
    ) {
      return;
    }
    const scope = this.activeScope;
    await this.options.transport
      .resize({
        computerId: this.options.computerId,
        sessionId: scope.sessionId,
        attachId: scope.attachId,
        attachGeneration: scope.attachGeneration,
        cols,
        rows,
      })
      .catch(() => {});
  }

  async detach(): Promise<void> {
    const scope = this.activeScope;
    this.attemptCounter += 1;
    this.cleanupActiveAttach();
    if (!this.disposed) {
      this.emitState({
        status: "disconnected",
        mode: this.activeMode,
        shellKind: null,
        dimensions: null,
        notice: null,
      });
    }
    if (!scope) return;
    await this.options.transport
      .detach({
        computerId: this.options.computerId,
        sessionId: scope.sessionId,
        attachId: scope.attachId,
        attachGeneration: scope.attachGeneration,
      })
      .catch(() => {});
  }

  async closeShell(): Promise<void> {
    const scope = this.activeScope;
    this.attemptCounter += 1;
    this.cleanupActiveAttach();
    await this.options.transport.close({
      computerId: this.options.computerId,
      ...(scope
        ? {
            sessionId: scope.sessionId,
            attachId: scope.attachId,
            attachGeneration: scope.attachGeneration,
          }
        : {}),
    });
    if (!this.disposed) {
      this.emitState({
        status: "disconnected",
        mode: this.activeMode,
        shellKind: null,
        dimensions: null,
        notice: null,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    const scope = this.activeScope;
    this.disposed = true;
    this.attemptCounter += 1;
    this.cleanupActiveAttach();
    if (scope) {
      void this.options.transport
        .detach({
          computerId: this.options.computerId,
          sessionId: scope.sessionId,
          attachId: scope.attachId,
          attachGeneration: scope.attachGeneration,
        })
        .catch(() => {});
    }
  }

  private handleBinaryFrame(attempt: number, scope: TerminalScope, bytes: Uint8Array): void {
    let frame: ComputerTerminalFrame;
    try {
      frame = decodeTerminalFrame(bytes);
    } catch {
      return;
    }
    if (!isCurrentTerminalAttach(scope, frame)) return;

    const { event } = frame;
    if (event.case === "opened") {
      this.clearOpenTimer();
      this.exitNotice = null;
      this.options.onResetOutput?.();
      this.replay = new TerminalSnapshotReplay(frame);
      const { shellKind, cols, rows, historyUnavailable, nextOutputSeq } = event.value;
      const truncated = historyUnavailable && nextOutputSeq > 1;
      this.emitState({
        status: "connected",
        mode: this.activeMode,
        shellKind,
        dimensions: { cols, rows },
        notice: truncated ? { kind: "history_unavailable" } : null,
      });
      return;
    }

    if (event.case === "snapshot" || event.case === "output") {
      if (!this.replay) return;
      try {
        this.replay.accept(frame);
      } catch {
        this.cleanupActiveAttach();
        this.emitState({
          status: "disconnected",
          mode: this.activeMode,
          shellKind: this.state.shellKind,
          dimensions: this.state.dimensions,
          notice: { kind: "snapshot_gap" },
        });
        void this.options.transport
          .detach({
            computerId: this.options.computerId,
            sessionId: scope.sessionId,
            attachId: scope.attachId,
            attachGeneration: scope.attachGeneration,
          })
          .catch(() => {});
        return;
      }
      if (event.value.bytes.byteLength > 0) {
        this.options.onOutput(event.value.bytes);
      }
      return;
    }

    if (event.case === "inputAccepted") {
      this.inputQueue.acknowledge(event.value.inputSeq);
      return;
    }

    if (event.case === "exit") {
      if (event.value.status.case === "signal") {
        this.exitNotice = { kind: "exited_signal", signal: event.value.status.value };
      } else {
        this.exitNotice = { kind: "exited_code", code: event.value.status.value ?? 0 };
      }
      return;
    }

    if (event.case === "error") {
      const code = event.value.code;
      if (code === "input_sequence") {
        this.inputQueue.reset();
        return;
      }
      this.attemptCounter += 1;
      this.cleanupActiveAttach();
      if (code === "permission_denied") {
        this.emitState({
          status: "unauthorized",
          mode: this.activeMode,
          shellKind: null,
          dimensions: null,
          notice: { kind: "unauthorized" },
        });
        return;
      }
      const notice: TerminalNotice =
        code === "attach_conflict"
          ? { kind: "conflict" }
          : code === "output_backpressure"
            ? { kind: "output_backpressure" }
            : code === "daemon_replaced"
              ? { kind: "daemon_replaced" }
              : code === "spawn_failed"
                ? { kind: "spawn_failed" }
                : { kind: "disconnected" };
      this.emitState({
        status: "disconnected",
        mode: this.activeMode,
        shellKind: null,
        dimensions: null,
        notice,
      });
      return;
    }

    if (event.case === "closed") {
      if (attempt !== this.attemptCounter) return;
      this.attemptCounter += 1;
      const reason = event.value.reason;
      const savedExitNotice = this.exitNotice;
      this.cleanupActiveAttach();
      if (reason === "permission_denied") {
        this.emitState({
          status: "unauthorized",
          mode: this.activeMode,
          shellKind: null,
          dimensions: null,
          notice: { kind: "unauthorized" },
        });
        return;
      }
      const notice: TerminalNotice | null =
        reason === "daemon_replaced"
          ? { kind: "daemon_replaced" }
          : reason === "output_backpressure"
            ? { kind: "output_backpressure" }
            : (savedExitNotice ?? null);
      this.emitState({
        status: "disconnected",
        mode: this.activeMode,
        shellKind: null,
        dimensions: null,
        notice,
      });
    }
  }

  private async handleUnexpectedDisconnect(attempt = this.attemptCounter): Promise<void> {
    if (attempt !== this.attemptCounter || this.disposed) return;
    this.attemptCounter += 1;
    const scope = this.activeScope;
    this.cleanupActiveAttach();
    if (scope) {
      void this.options.transport
        .detach({
          computerId: this.options.computerId,
          sessionId: scope.sessionId,
          attachId: scope.attachId,
          attachGeneration: scope.attachGeneration,
        })
        .catch(() => {});
    }
    await this.resolvePostDisconnectStatus(this.attemptCounter);
  }

  private async resolvePostDisconnectStatus(expectedCounter: number): Promise<void> {
    try {
      const snapshot = await this.options.transport.readStatus({
        computerId: this.options.computerId,
      });
      if (expectedCounter !== this.attemptCounter || this.disposed) return;
      if (snapshot.unauthorized || !snapshot.enabled) {
        this.emitState({
          status: "unauthorized",
          mode: this.activeMode,
          shellKind: null,
          dimensions: null,
          notice: { kind: "unauthorized" },
        });
        return;
      }
      if (snapshot.status === "needs_upgrade") {
        this.emitState({
          status: "needs_upgrade",
          mode: this.activeMode,
          shellKind: null,
          dimensions: null,
          notice: null,
        });
        return;
      }
      if (snapshot.status === "unsupported") {
        this.emitState({
          status: "unsupported",
          mode: this.activeMode,
          shellKind: null,
          dimensions: null,
          notice: null,
        });
        return;
      }
    } catch {}
    if (expectedCounter !== this.attemptCounter || this.disposed) return;
    this.emitState({
      status: "disconnected",
      mode: this.activeMode,
      shellKind: null,
      dimensions: null,
      notice: { kind: "disconnected" },
    });
  }

  private cleanupActiveAttach(): void {
    this.clearOpenTimer();
    this.unsubscribeChannel?.();
    this.unsubscribeChannel = null;
    this.activeScope = null;
    this.replay = null;
    this.hasSubscribed = false;
    this.exitNotice = null;
    this.inputQueue.reset();
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private emitState(next: ComputerTerminalControllerState): void {
    this.state = next;
    this.options.onStateChange(next);
  }
}
