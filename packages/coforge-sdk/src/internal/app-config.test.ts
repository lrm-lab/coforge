import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AppConfigSyncSchema } from "#src/internal/gen/coforge/rpc/v1/app_config_pb";
import {
  APP_CONFIG_DEFINITIONS,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
  decodeAppConfigSnapshotRequest,
  decodeAppConfigSync,
  decodeReminderSync,
  encodeAppConfigSnapshotRequest,
  encodeAppConfigSync,
  encodeReminderSync,
  validateCleanerAppConfig,
  type AppConfigSync,
} from "./index";

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
};
const cleaner = {
  appId: CLEANER_APP_ID,
  ownerAgentId: "agent-1",
  revision: 3,
  effective: { enabled: false, thresholdBytes: 8192, intervalMs: 1_800_000 },
} as const;
const sync = (value: Partial<AppConfigSync> = {}): AppConfigSync => ({
  ...scope,
  operation: "snapshot",
  configs: [cleaner],
  messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
  ...value,
});
/** Wire bytes the codec's own encoder would refuse, as an older or newer server may send them. */
const wire = (configs: object[], operation = "snapshot") =>
  toBinary(
    AppConfigSyncSchema,
    create(AppConfigSyncSchema, {
      ...scope,
      operation,
      messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
      configs: configs as never,
    }),
  );
const cleanerWire = (value: Partial<typeof cleaner> = {}) => ({
  appId: cleaner.appId,
  ownerAgentId: cleaner.ownerAgentId,
  revision: cleaner.revision,
  effective: { case: "cleaner", value: cleaner.effective },
  ...value,
});

test("a snapshot and an upsert round-trip with their typed App settings", () => {
  expect(decodeAppConfigSync(encodeAppConfigSync(sync()))).toEqual(sync());
  const upsert = sync({ operation: "upsert" });
  expect(decodeAppConfigSync(encodeAppConfigSync(upsert))).toEqual(upsert);
  const empty = sync({ configs: [] });
  expect(decodeAppConfigSync(encodeAppConfigSync(empty))).toEqual(empty);
});

test("an upsert carries exactly one config, owned by the Agent it names", () => {
  expect(() => encodeAppConfigSync(sync({ operation: "upsert", configs: [] }))).toThrow();
  expect(() =>
    decodeAppConfigSync(
      wire([cleanerWire(), cleanerWire({ revision: 4 } as never)], "upsert") as Uint8Array,
    ),
  ).toThrow();
  expect(() =>
    decodeAppConfigSync(wire([cleanerWire({ ownerAgentId: "agent-2" } as never)], "upsert")),
  ).toThrow("owner");
});

test("a snapshot refuses another owner's row and two rows for one App", () => {
  expect(() =>
    decodeAppConfigSync(wire([cleanerWire({ ownerAgentId: "agent-2" } as never)])),
  ).toThrow("owner");
  expect(() => decodeAppConfigSync(wire([cleanerWire(), cleanerWire()]))).toThrow("duplicate");
});

test("a row for an App this side does not know is dropped, whatever it claims", () => {
  const unknown = { appId: "system.future", ownerAgentId: "agent-2", revision: 1 };
  expect(decodeAppConfigSync(wire([unknown, cleanerWire()])).configs).toEqual([cleaner]);
  expect(decodeAppConfigSync(wire([unknown], "upsert")).configs).toEqual([]);
  expect(decodeAppConfigSync(wire([unknown, unknown])).configs).toEqual([]);
});

test("a known App's row must carry its own settings within their bounds", () => {
  expect(() =>
    decodeAppConfigSync(wire([cleanerWire({ effective: undefined } as never)])),
  ).toThrow();
  for (const effective of [
    { ...cleaner.effective, thresholdBytes: 4095 },
    { ...cleaner.effective, thresholdBytes: 1_073_741_825 },
    { ...cleaner.effective, intervalMs: 899_999 },
    { ...cleaner.effective, intervalMs: 604_800_001 },
  ])
    expect(() =>
      decodeAppConfigSync(
        wire([cleanerWire({ effective: { case: "cleaner", value: effective } } as never)]),
      ),
    ).toThrow("cleaner");
});

test("the sync names its message type, so no other publication is read as one", () => {
  expect(() =>
    decodeAppConfigSync(
      toBinary(
        AppConfigSyncSchema,
        create(AppConfigSyncSchema, { ...scope, operation: "snapshot", messageType: "other" }),
      ),
    ),
  ).toThrow();
  const reminder = encodeReminderSync({
    ...scope,
    operation: "snapshot",
    jobs: [],
    messageType: "coforge.rpc.v1.ReminderSync",
  });
  expect(() => decodeAppConfigSync(reminder)).toThrow();
  expect(() => decodeReminderSync(encodeAppConfigSync(sync()))).toThrow();
});

test("a snapshot request round-trips its scope and refuses another protocol", () => {
  expect(decodeAppConfigSnapshotRequest(encodeAppConfigSnapshotRequest(scope))).toEqual(scope);
  expect(() => encodeAppConfigSnapshotRequest({ ...scope, protocolMajor: 2 })).toThrow();
});

test("cleaner settings bound as the reference Computer's do, with an 8 KiB default threshold", () => {
  expect(CLEANER_CONFIG_DEFAULTS).toEqual({
    enabled: true,
    thresholdBytes: 8_192,
    intervalMs: 3_600_000,
  });
  expect(
    validateCleanerAppConfig({ enabled: true, thresholdBytes: 4096, intervalMs: 900_000 }),
  ).toEqual({ enabled: true, thresholdBytes: 4096, intervalMs: 900_000 });
  expect(
    validateCleanerAppConfig({
      enabled: false,
      thresholdBytes: 1_073_741_824,
      intervalMs: 604_800_000,
    }),
  ).toEqual({ enabled: false, thresholdBytes: 1_073_741_824, intervalMs: 604_800_000 });
  for (const value of [
    null,
    [],
    { enabled: true, thresholdBytes: 65_536 },
    { enabled: "yes", thresholdBytes: 65_536, intervalMs: 3_600_000 },
    { enabled: true, thresholdBytes: 65_536.5, intervalMs: 3_600_000 },
    { enabled: true, thresholdBytes: 65_536, intervalMs: 3_600_000, extra: 1 },
  ])
    expect(() => validateCleanerAppConfig(value)).toThrow("cleaner");
});

test("an Agent reads and sets the cleaner by snake_case keys in whole seconds", () => {
  const definition = APP_CONFIG_DEFINITIONS[CLEANER_APP_ID];
  expect(definition.fields).toEqual({
    enabled: { type: "boolean" },
    threshold_bytes: { type: "integer", minimum: 4096, maximum: 1_073_741_824 },
    interval_seconds: { type: "integer", minimum: 900, maximum: 604_800 },
  });
  expect(definition.defaults).toEqual({
    enabled: true,
    threshold_bytes: 8_192,
    interval_seconds: 3600,
  });
  expect(
    definition.settings({ enabled: false, threshold_bytes: 8192, interval_seconds: 1800 }),
  ).toEqual({ enabled: false, thresholdBytes: 8192, intervalMs: 1_800_000 });
});

test("a revision must be a non-negative integer", () => {
  expect(() => encodeAppConfigSync(sync({ configs: [{ ...cleaner, revision: -1 }] }))).toThrow(
    "revision",
  );
  expect(() => encodeAppConfigSync(sync({ configs: [{ ...cleaner, revision: 1.5 }] }))).toThrow(
    "revision",
  );
});
