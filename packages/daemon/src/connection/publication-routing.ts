import {
  AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
  AGENT_CONFIG_SYNC_MESSAGE_TYPE,
  AGENT_INBOX_PURGE_MESSAGE_TYPE,
  AGENT_MESSAGE_METHOD,
  AGENT_MIGRATION_CANCEL_MESSAGE_TYPE,
  AGENT_MIGRATION_LEASE_MESSAGE_TYPE,
  AGENT_SERVER_FEATURES_MESSAGE_TYPE,
  AGENT_START_MESSAGE_TYPE,
  AGENT_STOP_MESSAGE_TYPE,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
  COMPUTER_RESTART_MESSAGE_TYPE,
  COMPUTER_UPGRADE_MESSAGE_TYPE,
  MODEL_REFRESH_MESSAGE_TYPE,
  REMINDER_DUE_MESSAGE_TYPE,
  REMINDER_SYNC_MESSAGE_TYPE,
  RESET_CREDIT_MESSAGE_TYPE,
  USAGE_SCAN_MESSAGE_TYPE,
} from "@lrm/coforge-sdk/internal";
import { APP_REGISTRATION_NOTICE_MESSAGE_TYPE } from "@lrm/coforge-sdk/internal/app-registration-notice";

import { COMPUTER_TERMINAL_CONTROL_MESSAGE_TYPE } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

export type DaemonQueryKind =
  | "pi_chat"
  | "agent_memory"
  | "agent_skills"
  | "agent_workspace_files_list"
  | "agent_workspace_scan"
  | "agent_workspace_file_read"
  | "agent_workspace_delete"
  | "agent_context_view"
  | "agent_side_ask"
  | "runtime_manage";

export type ServerPublicationKind =
  | "reminder_due"
  | "stale_runtime_stop"
  | "agent_config_sync"
  | "app_config_sync"
  | "agent_server_features";

export type ComputerLifecycleKind = "computer_upgrade" | "computer_restart";

export type DaemonProviderKind = "usage_scan" | "reset_credit" | "model_refresh" | "effort_read";

export type PublicationKind =
  | "computer_terminal"
  | "runtime_auth"
  | DaemonQueryKind
  | "reminder_sync"
  | ServerPublicationKind
  | "app_registration_notice"
  | "agent_migration_lease"
  | "agent_migration_cancel"
  | ComputerLifecycleKind
  | "agent_workspace_reset"
  | DaemonProviderKind
  | "agent_activity_probe"
  | "agent_inbox_purge"
  | "agent_message"
  | "agent_stop"
  | "agent_turn_interrupt"
  | "agent_start";

const PUBLICATION_ORDER: readonly PublicationKind[] = [
  "computer_terminal",
  "runtime_auth",
  "pi_chat",
  "agent_memory",
  "agent_skills",
  "agent_workspace_files_list",
  "agent_workspace_scan",
  "agent_workspace_file_read",
  "agent_workspace_delete",
  "agent_context_view",
  "agent_side_ask",
  "runtime_manage",
  "reminder_sync",
  "reminder_due",
  "stale_runtime_stop",
  "agent_config_sync",
  "app_config_sync",
  "agent_server_features",
  "app_registration_notice",
  "agent_migration_lease",
  "agent_migration_cancel",
  "computer_upgrade",
  "computer_restart",
  "agent_workspace_reset",
  "usage_scan",
  "reset_credit",
  "model_refresh",
  "effort_read",
  "agent_activity_probe",
  "agent_inbox_purge",
  "agent_message",
  "agent_stop",
  "agent_turn_interrupt",
  "agent_start",
];

const PUBLICATION_PRIORITY = new Map<PublicationKind, number>(
  PUBLICATION_ORDER.map((kind, index) => [kind, index]),
);

const DISCRIMINATOR_FIELDS = new Map<number, ReadonlyMap<string, PublicationKind>>([
  [
    2,
    new Map([
      ["coforge.rpc.v1.PiChatRequest", "pi_chat"],
      ["coforge.rpc.v1.AgentMemoryRequest", "agent_memory"],
    ]),
  ],
  [
    5,
    new Map([
      ["coforge.rpc.v1.AgentWorkspaceScanRequest", "agent_workspace_scan"],
      [COMPUTER_RESTART_MESSAGE_TYPE, "computer_restart"],
    ]),
  ],
  [
    6,
    new Map([
      ["coforge.rpc.v1.AgentWorkspaceDeleteRequest", "agent_workspace_delete"],
      [COMPUTER_UPGRADE_MESSAGE_TYPE, "computer_upgrade"],
      [USAGE_SCAN_MESSAGE_TYPE, "usage_scan"],
      [MODEL_REFRESH_MESSAGE_TYPE, "model_refresh"],
      [COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE, "effort_read"],
      [AGENT_STOP_MESSAGE_TYPE, "agent_stop"],
    ]),
  ],
  [
    7,
    new Map([
      ["coforge.rpc.v1.AgentSkillsListRequest", "agent_skills"],
      ["coforge.rpc.v1.AgentWorkspaceFileReadRequest", "agent_workspace_file_read"],
      [RESET_CREDIT_MESSAGE_TYPE, "reset_credit"],
      [AGENT_ACTIVITY_PROBE_MESSAGE_TYPE, "agent_activity_probe"],
    ]),
  ],
  [
    8,
    new Map([
      [COMPUTER_TERMINAL_CONTROL_MESSAGE_TYPE, "computer_terminal"],
      ["coforge.rpc.v1.RuntimeAuthIntent", "runtime_auth"],
      ["coforge.rpc.v1.AgentWorkspaceFilesListRequest", "agent_workspace_files_list"],
      [REMINDER_DUE_MESSAGE_TYPE, "reminder_due"],
      [APP_CONFIG_SYNC_MESSAGE_TYPE, "app_config_sync"],
      [AGENT_SERVER_FEATURES_MESSAGE_TYPE, "agent_server_features"],
      [APP_REGISTRATION_NOTICE_MESSAGE_TYPE, "app_registration_notice"],
      [AGENT_MESSAGE_METHOD, "agent_message"],
      ["coforge.rpc.v1.AgentTurnInterruptIntent", "agent_turn_interrupt"],
    ]),
  ],
  [
    9,
    new Map([
      ["coforge.rpc.v1.AgentContextViewRequest", "agent_context_view"],
      ["coforge.rpc.v1.RuntimeManageRequest", "runtime_manage"],
      ["coforge.rpc.v1.AgentWorkspaceResetRequest", "agent_workspace_reset"],
      [AGENT_INBOX_PURGE_MESSAGE_TYPE, "agent_inbox_purge"],
    ]),
  ],
  [
    10,
    new Map([
      ["coforge.rpc.v1.AgentSideAskRequest", "agent_side_ask"],
      [REMINDER_SYNC_MESSAGE_TYPE, "reminder_sync"],
      [AGENT_MIGRATION_CANCEL_MESSAGE_TYPE, "agent_migration_cancel"],
    ]),
  ],
  [
    11,
    new Map([
      [AGENT_MIGRATION_LEASE_MESSAGE_TYPE, "agent_migration_lease"],
      [AGENT_START_MESSAGE_TYPE, "agent_start"],
    ]),
  ],
  [13, new Map([[AGENT_CONFIG_SYNC_MESSAGE_TYPE, "agent_config_sync"]])],
]);

type FieldMatcher = {
  values: ReadonlyMap<string, PublicationKind>;
  lengths: ReadonlySet<number>;
};

const utf8Decoder = new TextDecoder();

const FIELD_MATCHERS = new Map<number, FieldMatcher>(
  Array.from(DISCRIMINATOR_FIELDS, ([field, values]) => [
    field,
    {
      values,
      lengths: new Set(Array.from(values.keys(), (key) => Buffer.byteLength(key, "utf8"))),
    },
  ]),
);

function readUint32Varint(
  data: Uint8Array,
  start: number,
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < data.byteLength && shift <= 28; offset++) {
    const byte = data[offset]!;
    if (shift === 28 && byte > 0x0f) return null;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: offset + 1 };
    shift += 7;
  }
  return null;
}

function skipVarint(data: Uint8Array, start: number): number {
  const limit = Math.min(data.byteLength, start + 10);
  for (let offset = start; offset < limit; offset++) {
    if ((data[offset]! & 0x80) === 0) return offset + 1;
  }
  return -1;
}

export function scanPublicationKinds(data: Uint8Array): PublicationKind[] {
  if (data.byteLength === 0) return [];
  let matched: Map<number, PublicationKind> | undefined;
  let singleField = 0;
  let singleKind: PublicationKind | undefined;
  let hasField1Varint = false;
  let hasField6Varint = false;
  let staleShapeValid = true;
  let offset = 0;
  while (offset < data.byteLength) {
    const key = readUint32Varint(data, offset);
    if (!key) return [];
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 0) return [];
    offset = key.offset;
    if (wire === 0) {
      const next = skipVarint(data, offset);
      if (next === -1) return [];
      offset = next;
      if (field === 1) hasField1Varint = true;
      else if (field === 6) hasField6Varint = true;
      else staleShapeValid = false;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      if (offset > data.byteLength) return [];
      staleShapeValid = false;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      if (offset > data.byteLength) return [];
      staleShapeValid = false;
      continue;
    }
    if (wire !== 2) return [];
    const length = readUint32Varint(data, offset);
    if (!length) return [];
    const start = length.offset;
    const end = start + length.value;
    if (end > data.byteLength) return [];
    offset = end;
    if (field < 2 || field > 5) staleShapeValid = false;
    const matcher = FIELD_MATCHERS.get(field);
    if (!matcher) continue;
    const kind = matcher.lengths.has(length.value)
      ? matcher.values.get(utf8Decoder.decode(data.subarray(start, end)))
      : undefined;
    if (matched) {
      if (kind) matched.set(field, kind);
      else matched.delete(field);
    } else if (singleField === 0) {
      if (kind) {
        singleField = field;
        singleKind = kind;
      }
    } else if (singleField === field) {
      if (kind) singleKind = kind;
      else {
        singleField = 0;
        singleKind = undefined;
      }
    } else if (kind) {
      matched = new Map([
        [singleField, singleKind!],
        [field, kind],
      ]);
      singleField = 0;
      singleKind = undefined;
    }
  }
  if (matched && matched.size > 0) {
    const kinds = Array.from(matched.values());
    if (kinds.length > 1) {
      kinds.sort((a, b) => PUBLICATION_PRIORITY.get(a)! - PUBLICATION_PRIORITY.get(b)!);
    }
    return kinds;
  }
  if (singleKind) return [singleKind];
  if (staleShapeValid && hasField1Varint && hasField6Varint) return ["stale_runtime_stop"];
  return [];
}

export function routePublication<Value>(
  data: Uint8Array,
  decode: (data: Uint8Array) => Value,
  accept: (value: Value) => boolean,
): boolean {
  try {
    return accept(decode(data));
  } catch {
    return false;
  }
}
