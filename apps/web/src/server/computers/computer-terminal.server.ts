import {
  encodeTerminalControl,
  TERMINAL_MAX_CHUNK_BYTES,
  TERMINAL_MAX_DIMENSION,
  type TerminalScope,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { AppError } from "#src/lib/app-error";
import {
  makeTerminalScope,
  revokeComputerTerminalScope,
  revokeComputerTerminalWhenDaemonReplaced,
  revokeUserTerminalSessionAttachments,
  sendTerminalClose,
  unsubscribeTerminalAttach,
} from "./computer-terminal-revocation.server";
import type {
  ComputerTerminalStore,
  ExpectedTerminalAttach,
  TerminalAttachMode,
  TerminalScopeKey,
  TerminalSessionRecord,
} from "./computer-terminal-store.server";

export type TerminalViewer = {
  userId: string;
  workspaceId: string;
  loginGeneration?: number;
  devSkipAuth?: boolean;
};

export type TerminalAvailabilityStatus = "ready" | "needs_upgrade" | "disconnected" | "unsupported";

export type ComputerTerminalStatusSnapshot =
  | { unauthorized: true }
  | {
      unauthorized?: false;
      enabled: boolean;
      status: TerminalAvailabilityStatus;
      hasActiveSession: boolean;
      hasActiveAttach: boolean;
      platform: string | null;
    };

export type PrepareTerminalAttachResult =
  | {
      status: "prepared";
      scope: TerminalScope;
      channel: string;
      subscriptionToken: string;
      subscriptionExpiresAtMs: number;
      daemonInstanceId: string;
      mode: TerminalAttachMode;
      cols: number;
      rows: number;
    }
  | { status: "attach_conflict" };

export type SendTerminalInputResult =
  | { status: "accepted"; nextInputSeq: number }
  | { status: "duplicate"; nextInputSeq: number }
  | { status: "sequence_mismatch"; expectedInputSeq: number };

export type TerminalComputerRecord = {
  computerId: string;
  ownerId: string;
  isMember: boolean;
  platform: string | null;
  terminalEnabled: boolean;
  ownerWebLoginGeneration: number;
};

export interface ComputerTerminalRepository {
  findComputer(
    scope: TerminalScopeKey & { userId: string },
  ): Promise<TerminalComputerRecord | undefined>;
  setTerminalEnabled(scope: TerminalScopeKey, enabled: boolean): Promise<void>;
}

export type ComputerTerminalPorts = {
  repository: ComputerTerminalRepository;
  store: ComputerTerminalStore;
  online(scope: TerminalScopeKey): Promise<boolean>;
  supportsCapability(scope: TerminalScopeKey, workerInstanceId: string): Promise<boolean>;
  daemonIdentity(scope: TerminalScopeKey): Promise<{ workerInstanceId: string } | undefined>;
  publishControl(workspaceId: string, computerId: string, bytes: Uint8Array): Promise<void>;
  publishFrame(channel: string, bytes: Uint8Array): Promise<void>;
  unsubscribeUserChannel(
    subscriptions: readonly { user: string; channel: string }[],
  ): Promise<void>;
  issueSubscriptionToken(input: {
    userId: string;
    attachId: string;
  }): Promise<{ token: string; channel: string; expiresAtMs: number }>;
  now?: () => number;
};

function isSupportedPlatform(platform: string | null): boolean {
  const normalized = platform?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "darwin" || normalized === "linux";
}

function validDimensions(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    cols <= TERMINAL_MAX_DIMENSION &&
    rows >= 1 &&
    rows <= TERMINAL_MAX_DIMENSION
  );
}

export class ComputerTerminalService {
  private readonly now: () => number;

  constructor(private readonly ports: ComputerTerminalPorts) {
    this.now = ports.now ?? Date.now;
  }

  async readStatus(
    viewer: TerminalViewer,
    computerId: string,
  ): Promise<ComputerTerminalStatusSnapshot> {
    const scope = { workspaceId: viewer.workspaceId, computerId };
    const record = await this.ports.repository.findComputer({ ...scope, userId: viewer.userId });
    if (!this.isAuthorizedOwner(viewer, record)) return { unauthorized: true };

    const [runtime, session] = await Promise.all([
      this.resolveRuntime(scope, record.platform),
      this.ports.store.getSession(scope),
    ]);
    return {
      enabled: record.terminalEnabled,
      status: runtime.status,
      hasActiveSession: Boolean(session),
      hasActiveAttach: Boolean(session?.activeAttach),
      platform: record.platform,
    };
  }

  async setEnabled(
    viewer: TerminalViewer,
    computerId: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    const scope = { workspaceId: viewer.workspaceId, computerId };
    await this.requireOwner(viewer, computerId);
    await this.ports.repository.setTerminalEnabled(scope, enabled);
    if (!enabled) {
      await this.revokeComputer({
        ...scope,
        closeShell: true,
        notifyReason: "permission_denied",
      });
    }
    return { enabled };
  }

  async prepareAttach(
    viewer: TerminalViewer,
    input: {
      computerId: string;
      cols: number;
      rows: number;
      takeover: boolean;
      mode: TerminalAttachMode;
    },
  ): Promise<PrepareTerminalAttachResult> {
    if (!validDimensions(input.cols, input.rows)) throw new AppError("INVALID_INPUT");
    const scope = { workspaceId: viewer.workspaceId, computerId: input.computerId };
    const record = await this.requireOwner(viewer, input.computerId);
    if (!record.terminalEnabled) throw new AppError("ACCESS_DENIED");
    const daemonInstanceId = await this.requireReadyDaemon(scope, record.platform);

    let existing = await this.ports.store.getSession(scope);
    if (existing && existing.daemonInstanceId !== daemonInstanceId) {
      await unsubscribeTerminalAttach(this.ports, existing);
      await this.ports.store.clearSession(scope, existing.sessionId);
      existing = undefined;
    }

    let sessionId: string;
    let attachGeneration: number;
    let effectiveCols = input.cols;
    let effectiveRows = input.rows;
    if (existing) {
      if (existing.activeAttach && !input.takeover) {
        return { status: "attach_conflict" };
      }
      if (existing.activeAttach) {
        await unsubscribeTerminalAttach(this.ports, existing);
      }
      sessionId = existing.sessionId;
      attachGeneration = existing.attachGeneration + 1;
      if (input.mode === "readonly") {
        effectiveCols = existing.cols;
        effectiveRows = existing.rows;
      }
    } else {
      sessionId = `ts_${crypto.randomUUID().replaceAll("-", "")}`;
      attachGeneration = 1;
    }

    const attachId = `ta_${crypto.randomUUID().replaceAll("-", "")}`;
    const nextSession: TerminalSessionRecord = {
      workspaceId: viewer.workspaceId,
      computerId: input.computerId,
      ownerUserId: viewer.userId,
      sessionId,
      daemonInstanceId,
      attachGeneration,
      cols: effectiveCols,
      rows: effectiveRows,
      activeAttach: {
        attachId,
        attachGeneration,
        loginGeneration: record.ownerWebLoginGeneration,
        mode: input.mode,
        nextInputSeq: 1,
        cols: effectiveCols,
        rows: effectiveRows,
        opened: false,
        createdAtMs: this.now(),
      },
      updatedAtMs: this.now(),
    };
    await this.ports.store.saveSession(nextSession);

    const tokenGrant = await this.ports.issueSubscriptionToken({
      userId: viewer.userId,
      attachId,
    });
    return {
      status: "prepared",
      scope: makeTerminalScope(nextSession, attachId, attachGeneration),
      channel: tokenGrant.channel,
      subscriptionToken: tokenGrant.token,
      subscriptionExpiresAtMs: tokenGrant.expiresAtMs,
      daemonInstanceId,
      mode: input.mode,
      cols: effectiveCols,
      rows: effectiveRows,
    };
  }

  async activateAttach(
    viewer: TerminalViewer,
    input: ExpectedTerminalAttach & {
      computerId: string;
      cols: number;
      rows: number;
      takeover: boolean;
    },
  ): Promise<void> {
    if (!validDimensions(input.cols, input.rows)) throw new AppError("INVALID_INPUT");
    const { scope, session } = await this.requireActiveAttach(viewer, input.computerId, input);
    const effectiveCols = session.activeAttach?.mode === "readonly" ? session.cols : input.cols;
    const effectiveRows = session.activeAttach?.mode === "readonly" ? session.rows : input.rows;
    await this.ports.publishControl(
      scope.workspaceId,
      scope.computerId,
      encodeTerminalControl({
        ...makeTerminalScope(session, input.attachId, input.attachGeneration),
        command: {
          case: "openOrAttach",
          value: { cols: effectiveCols, rows: effectiveRows, takeover: input.takeover },
        },
      }),
    );
  }

  async refreshSubscription(
    viewer: TerminalViewer,
    input: ExpectedTerminalAttach & { computerId: string },
  ): Promise<{ token: string; channel: string; expiresAtMs: number }> {
    await this.requireActiveAttach(viewer, input.computerId, input);
    return this.ports.issueSubscriptionToken({
      userId: viewer.userId,
      attachId: input.attachId,
    });
  }

  async sendInput(
    viewer: TerminalViewer,
    input: ExpectedTerminalAttach & {
      computerId: string;
      inputSeq: number;
      bytes: Uint8Array;
    },
  ): Promise<SendTerminalInputResult> {
    if (
      !Number.isInteger(input.inputSeq) ||
      input.inputSeq < 1 ||
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > TERMINAL_MAX_CHUNK_BYTES
    ) {
      throw new AppError("INVALID_INPUT");
    }
    const { scope, session } = await this.requireActiveAttach(viewer, input.computerId, input, {
      requireInteractive: true,
    });
    const advanced = await this.ports.store.advanceInputSeq(
      scope,
      {
        sessionId: input.sessionId,
        attachId: input.attachId,
        attachGeneration: input.attachGeneration,
      },
      input.inputSeq,
    );
    if (advanced.outcome === "invalid_attach") throw new AppError("ACCESS_DENIED");
    if (advanced.outcome === "duplicate") {
      return { status: "duplicate", nextInputSeq: advanced.nextInputSeq };
    }
    if (advanced.outcome === "sequence_mismatch") {
      return { status: "sequence_mismatch", expectedInputSeq: advanced.expectedInputSeq };
    }

    await this.ports.publishControl(
      scope.workspaceId,
      scope.computerId,
      encodeTerminalControl({
        ...makeTerminalScope(session, input.attachId, input.attachGeneration),
        command: {
          case: "input",
          value: { inputSeq: input.inputSeq, bytes: input.bytes },
        },
      }),
    );
    return { status: "accepted", nextInputSeq: advanced.nextInputSeq };
  }

  async resize(
    viewer: TerminalViewer,
    input: ExpectedTerminalAttach & {
      computerId: string;
      cols: number;
      rows: number;
    },
  ): Promise<void> {
    if (!validDimensions(input.cols, input.rows)) throw new AppError("INVALID_INPUT");
    const { scope, session } = await this.requireActiveAttach(viewer, input.computerId, input, {
      requireInteractive: true,
    });
    await this.ports.store.updateDimensions(
      scope,
      {
        sessionId: input.sessionId,
        attachId: input.attachId,
        attachGeneration: input.attachGeneration,
      },
      input.cols,
      input.rows,
    );
    await this.ports.publishControl(
      scope.workspaceId,
      scope.computerId,
      encodeTerminalControl({
        ...makeTerminalScope(session, input.attachId, input.attachGeneration),
        command: {
          case: "resize",
          value: { cols: input.cols, rows: input.rows },
        },
      }),
    );
  }

  async detach(
    viewer: TerminalViewer,
    input: ExpectedTerminalAttach & { computerId: string },
  ): Promise<void> {
    const scope = { workspaceId: viewer.workspaceId, computerId: input.computerId };
    await this.requireOwner(viewer, input.computerId);
    const detached = await this.ports.store.detachAttach(scope, {
      sessionId: input.sessionId,
      attachId: input.attachId,
      attachGeneration: input.attachGeneration,
    });
    if (!detached?.activeAttach) return;
    await unsubscribeTerminalAttach(this.ports, detached);
    await this.ports
      .publishControl(
        scope.workspaceId,
        scope.computerId,
        encodeTerminalControl({
          ...makeTerminalScope(
            detached,
            detached.activeAttach.attachId,
            detached.activeAttach.attachGeneration,
          ),
          command: { case: "detach", value: {} },
        }),
      )
      .catch(() => {});
  }

  async close(
    viewer: TerminalViewer,
    input: {
      computerId: string;
      sessionId?: string;
      attachId?: string;
      attachGeneration?: number;
    },
  ): Promise<void> {
    const scope = { workspaceId: viewer.workspaceId, computerId: input.computerId };
    await this.requireOwner(viewer, input.computerId);
    const cleared = await this.ports.store.clearSession(scope, input.sessionId);
    if (!cleared) return;
    await unsubscribeTerminalAttach(this.ports, cleared);
    await sendTerminalClose(this.ports, cleared);
  }

  async revokeComputer(input: {
    workspaceId: string;
    computerId: string;
    closeShell: boolean;
    notifyReason?: "daemon_replaced" | "permission_denied";
  }): Promise<void> {
    await revokeComputerTerminalScope(this.ports, input);
  }

  async revokeOnDaemonReplaced(
    scope: TerminalScopeKey,
    newWorkerInstanceId: string,
  ): Promise<void> {
    await revokeComputerTerminalWhenDaemonReplaced(this.ports, scope, newWorkerInstanceId);
  }

  async revokeUserAttachments(userId: string): Promise<void> {
    await revokeUserTerminalSessionAttachments(this.ports, userId);
  }

  private isAuthorizedOwner(
    viewer: TerminalViewer,
    record: TerminalComputerRecord | undefined,
  ): record is TerminalComputerRecord {
    if (!record || !record.isMember || record.ownerId !== viewer.userId) return false;
    if (viewer.devSkipAuth) return true;
    return viewer.loginGeneration === record.ownerWebLoginGeneration;
  }

  private async requireOwner(
    viewer: TerminalViewer,
    computerId: string,
  ): Promise<TerminalComputerRecord> {
    const record = await this.ports.repository.findComputer({
      workspaceId: viewer.workspaceId,
      computerId,
      userId: viewer.userId,
    });
    if (!this.isAuthorizedOwner(viewer, record)) {
      throw new AppError("ACCESS_DENIED");
    }
    return record;
  }

  private async resolveRuntime(
    scope: TerminalScopeKey,
    platform: string | null,
  ): Promise<{ status: TerminalAvailabilityStatus; daemonInstanceId?: string }> {
    if (!isSupportedPlatform(platform)) return { status: "unsupported" };
    const [online, identity] = await Promise.all([
      this.ports.online(scope),
      this.ports.daemonIdentity(scope),
    ]);
    if (!online || !identity) return { status: "disconnected" };
    const supported = await this.ports.supportsCapability(scope, identity.workerInstanceId);
    if (!supported) return { status: "needs_upgrade" };
    return { status: "ready", daemonInstanceId: identity.workerInstanceId };
  }

  private async requireReadyDaemon(
    scope: TerminalScopeKey,
    platform: string | null,
  ): Promise<string> {
    const runtime = await this.resolveRuntime(scope, platform);
    if (runtime.status === "unsupported") throw new AppError("INVALID_INPUT");
    if (runtime.status !== "ready" || !runtime.daemonInstanceId) {
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }
    return runtime.daemonInstanceId;
  }

  private async requireActiveAttach(
    viewer: TerminalViewer,
    computerId: string,
    expected: ExpectedTerminalAttach,
    options?: { requireInteractive?: boolean },
  ): Promise<{ scope: TerminalScopeKey; session: TerminalSessionRecord }> {
    const scope = { workspaceId: viewer.workspaceId, computerId };
    const record = await this.requireOwner(viewer, computerId);
    if (!record.terminalEnabled) throw new AppError("ACCESS_DENIED");
    const daemonInstanceId = await this.requireReadyDaemon(scope, record.platform);
    const session = await this.ports.store.getSession(scope);
    if (
      !session ||
      session.ownerUserId !== viewer.userId ||
      session.daemonInstanceId !== daemonInstanceId ||
      session.sessionId !== expected.sessionId ||
      !session.activeAttach ||
      session.activeAttach.attachId !== expected.attachId ||
      session.activeAttach.attachGeneration !== expected.attachGeneration ||
      session.activeAttach.loginGeneration !== record.ownerWebLoginGeneration ||
      (options?.requireInteractive && session.activeAttach.mode !== "interactive")
    ) {
      throw new AppError("ACCESS_DENIED");
    }
    return { scope, session };
  }
}
