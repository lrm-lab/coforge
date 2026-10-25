import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  RuntimeAuthStateKind,
  RuntimeAuthStatusReportSchema,
  RuntimeAuthUnavailableReason,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { RPC_METHODS } from "./rpc-methods";
import { boundedPayload } from "./bounded-payload";
import type { RuntimeAuthAccount } from "./runtime-auth-login";

/** Daemon -> server notice: this Computer's runtime login status, all runtimes together. */
export const RUNTIME_AUTH_STATUS_REPORT_METHOD = RPC_METHODS.daemonRuntimeAuthStatusReport;

export type RuntimeAuthStateName = "logged_in" | "logged_out" | "unknown" | "unavailable";
export type RuntimeAuthUnavailableReasonName =
  | "not_installed"
  | "version_unsupported"
  | "unsupported_installation";

/** One runtime's login status on the wire. Contents are sanitized by the sender and receiver. */
export type RuntimeAuthReportedState = {
  provider: string;
  state: RuntimeAuthStateName;
  account?: RuntimeAuthAccount;
  unavailableReason?: RuntimeAuthUnavailableReasonName;
};

export type RuntimeAuthStatusReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  collectedAtMs: number;
  runtimes: RuntimeAuthReportedState[];
};

const STATES: ReadonlyMap<RuntimeAuthStateName, RuntimeAuthStateKind> = new Map([
  ["logged_in", RuntimeAuthStateKind.LOGGED_IN],
  ["logged_out", RuntimeAuthStateKind.LOGGED_OUT],
  ["unknown", RuntimeAuthStateKind.UNKNOWN],
  ["unavailable", RuntimeAuthStateKind.UNAVAILABLE],
]);
const REASONS: ReadonlyMap<RuntimeAuthUnavailableReasonName, RuntimeAuthUnavailableReason> =
  new Map([
    ["not_installed", RuntimeAuthUnavailableReason.NOT_INSTALLED],
    ["version_unsupported", RuntimeAuthUnavailableReason.VERSION_UNSUPPORTED],
    ["unsupported_installation", RuntimeAuthUnavailableReason.UNSUPPORTED_INSTALLATION],
  ]);
const nameOf = <N, V>(map: ReadonlyMap<N, V>, value: V) =>
  [...map].find(([, wire]) => wire === value)?.[0];

const MAX_REPORT_BYTES = 16_384;
const LABEL = "runtime auth status report";

export function encodeRuntimeAuthStatusReport(value: RuntimeAuthStatusReport): Uint8Array {
  check(value);
  return boundedPayload(
    toBinary(
      RuntimeAuthStatusReportSchema,
      create(RuntimeAuthStatusReportSchema, {
        ...value,
        collectedAtMs: BigInt(value.collectedAtMs),
        runtimes: value.runtimes.map((runtime) => ({
          ...runtime,
          state: STATES.get(runtime.state) ?? RuntimeAuthStateKind.UNKNOWN,
          unavailableReason: runtime.unavailableReason
            ? REASONS.get(runtime.unavailableReason)
            : undefined,
        })),
      }),
    ),
    MAX_REPORT_BYTES,
    LABEL,
  );
}

/**
 * Decodes a report. A runtime whose state is unknown to this side, or unavailable without a known
 * reason, reads as `unknown`; an account survives only on `logged_in`, a reason only on
 * `unavailable`.
 */
export function decodeRuntimeAuthStatusReport(bytes: Uint8Array): RuntimeAuthStatusReport {
  const wire = fromBinary(
    RuntimeAuthStatusReportSchema,
    boundedPayload(bytes, MAX_REPORT_BYTES, LABEL),
  );
  const value: RuntimeAuthStatusReport = {
    protocolMajor: wire.protocolMajor,
    requestId: wire.requestId,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
    collectedAtMs: Number(wire.collectedAtMs),
    runtimes: wire.runtimes.map((runtime): RuntimeAuthReportedState => {
      const state = nameOf(STATES, runtime.state);
      const reason = nameOf(REASONS, runtime.unavailableReason);
      if (state === "logged_in")
        return {
          provider: runtime.provider,
          state,
          ...account(runtime.account),
        };
      if (state === "unavailable" && reason)
        return { provider: runtime.provider, state, unavailableReason: reason };
      if (state === "logged_out") return { provider: runtime.provider, state };
      return { provider: runtime.provider, state: "unknown" };
    }),
  };
  check(value);
  return value;
}

/** The account as `{ account }`, without absent labels, or nothing when it names nothing. */
function account(wire: RuntimeAuthAccount | undefined): { account?: RuntimeAuthAccount } {
  const { maskedLabel, planLabel, methodLabel } = wire ?? {};
  const value = {
    ...(maskedLabel !== undefined ? { maskedLabel } : {}),
    ...(planLabel !== undefined ? { planLabel } : {}),
    ...(methodLabel !== undefined ? { methodLabel } : {}),
  };
  return Object.keys(value).length > 0 ? { account: value } : {};
}

function check(value: RuntimeAuthStatusReport) {
  if (
    value.protocolMajor !== 1 ||
    !Number.isSafeInteger(value.collectedAtMs) ||
    [value.requestId, value.workspaceId, value.computerId].some(
      (field) => !field.trim() || field.length > 512,
    )
  )
    throw new Error(`invalid ${LABEL}`);
}
