import type {
  InitializeResponse,
  RequestPermissionRequest,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AgentRuntimeEvent } from "@coforge/agent";
import type { AcpConnection } from "./connection";

/** The messages a runtime's own ACP protocol failures carry. */
export type AcpProfileMessages = Readonly<{
  unsupportedProtocol: string;
  closedBeforeConfig: string;
  timedOut: string;
}>;

/**
 * One ACP runtime's differences, declared in one place: the arguments its connection adds to the
 * resolved executable, the identity its sessions announce, the notifications it publishes beyond
 * `session/update`, how it reads published configuration, and the wording of its own failures.
 *
 * `acpProcess` builds the process and client from a profile; a later `acpSession` derives the
 * session state machine from the same profile, so a runtime's differences cannot drift between
 * the two layers.
 */
export type AcpRuntimeProfile = Readonly<{
  /** Arguments after the resolved executable, before any the caller appends. */
  args: readonly string[];
  /** Extra ACP notification methods this runtime publishes, observed like `session/update`. */
  notifications?: readonly string[];
  /** Reads a `config_option_update` into the options this runtime publishes; absent for a
   * runtime that never publishes configuration this way. */
  readConfig?(update: Readonly<Record<string, unknown>>): SessionConfigOption[] | undefined;
  /** Whether a published option offers a usable selection for `category`. */
  configReady?(option: SessionConfigOption, category: string): boolean;
  /** Refuses an initialize response whose capabilities this runtime needs. */
  capabilityCheck?(response: InitializeResponse): void;
  messages: AcpProfileMessages;
}>;

/** One turn's provider projection: the events one update carries, and what the turn's end adds. */
export type AcpTurnReader = Readonly<{
  read(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[];
  end(): AgentRuntimeEvent[];
}>;

/** A turn the runtime started itself: its prompt id when it starts, its end when it stops. */
export type AcpNativeTurn = Readonly<{
  promptId: string;
  end?: Readonly<{
    status: "completed" | "interrupted" | "failed";
    error?: Extract<AgentRuntimeEvent, { type: "error" }>;
  }>;
}>;

/**
 * A runtime's request that inserts a notice into the live turn. The notice keeps its single
 * delivery acknowledgement: a refusal is reported as `notice-undelivered` for the daemon to
 * redeliver once idle, and an unanswered request leaves the outcome unknown.
 */
export type AcpSteerProfile = Readonly<{
  /** The ACP request that inserts `text` into the session's live turn. */
  request(text: string, sessionId: string): Readonly<{ method: string; params: unknown }>;
  /** The request's answer can arrive only when the turn it steered ends, past the ACP
   * deadline a live request otherwise gets. `session/prompt`-as-steer runtimes set this. */
  unboundedRequest?: boolean;
  /** Reads the request's answer: whether the runtime took the text, and its native id. */
  accepted(response: unknown): { accepted: boolean; id?: string };
  /** Reads a notification's steer outcome, for a runtime that reports delivery itself. */
  outcome?(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): { id: string; state: "injected" | "cleared" } | undefined;
  /** Takes back a steer the runtime queued but no turn will read. */
  abandon?(id: string): Promise<void>;
  /**
   * Reads a turn the runtime started itself, which runs an accepted steer when the previous turn
   * ended before the insertion. `ownPromptId` is the prompt this session wrote, so a runtime
   * never reports that turn as its own.
   */
  nativeTurn?(
    method: string,
    params: Readonly<Record<string, unknown>>,
    ownPromptId: string | undefined,
  ): AcpNativeTurn | undefined;
}>;

/** What a runtime supplies to its session state machine. */
export type AcpSessionProfile = Readonly<{
  /** The runtime's own name in every message a person reads. */
  label: string;
  /** Builds this runtime's process and client, wired to the session's own update and permission
   * sinks. */
  openTransport(sink: AcpSessionSink): AcpConnection;
  /** Runs after `initialize` and before the session is created, for authentication the runtime
   * must complete first. */
  beforeSession?(transport: AcpConnection, initialized: InitializeResponse): Promise<void>;
  /**
   * Creates or resumes the native session after `initialize`, and applies the runtime's
   * configuration. Returns the session id and whether it continues an earlier conversation.
   */
  openSession(
    transport: AcpConnection,
    sessionId: string | undefined,
    initialized: InitializeResponse,
  ): Promise<{ sessionId: string; resumable: boolean; replacedSessionId?: string }>;
  /** One turn's event projection. */
  turn(): AcpTurnReader;
  /** Extra `_meta` for each `session/prompt`, keyed by the turn id this session assigns. */
  promptMeta?(turnId: string): Readonly<Record<string, unknown>>;
  /** Reads a native notification that proves the runtime took the prompt this session wrote,
   * before the turn produced any output. */
  promptAdmitted?(
    method: string,
    params: Readonly<Record<string, unknown>>,
    promptId: string,
  ): boolean;
  /** Reads a prompt answer's stop reason into the turn's status; absent for the shared rule:
   * `end_turn` completes, `cancelled` interrupts, and every other reason fails with an error
   * naming it. */
  stopStatus?(reason: string): Readonly<{
    status: "completed" | "interrupted" | "failed";
    error?: string;
  }>;
  /** How long an input may wait for the runtime to accept it before the session closes as
   * ambiguous; absent for a runtime whose inputs always settle. */
  admissionTimeoutMs?: number;
  /** Interrupts the live turn without `session/cancel`, for a runtime that does not implement
   * it — the Antigravity session kills its process instead. */
  cancelTurn?(transport: AcpConnection): Promise<void>;
  /** Inserts a notice into the live turn instead of waiting for the next one. */
  steer?: AcpSteerProfile;
  /** Anything the runtime owns outside the process: an instruction mod, private files. */
  cleanup?(): Promise<void>;
  /** Replaces a failed turn's scrubbed provider detail, for a failure the runtime names itself.
   * Returning a message drops the provider's error code with it. */
  detailMessage?(detail: string): string | undefined;
  /** Runs after an interrupt settled the turn, for work the runtime owes at that point. */
  afterInterrupt?(): Promise<void>;
}>;

export type AcpPermissionAnswer =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** What the transport wiring calls back into the session. */
export type AcpSessionSink = Readonly<{
  update(sessionId: string, update: Readonly<Record<string, unknown>>): void;
  /** A native notification this runtime publishes beside `session/update`, raw. */
  notification(method: string, params: Readonly<Record<string, unknown>>): void;
  permission(request: RequestPermissionRequest): { outcome: AcpPermissionAnswer };
  /** The runtime wrote a `session/prompt` frame: this turn was submitted. */
  promptWritten(): void;
}>;
