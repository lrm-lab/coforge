import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AppConfigSyncSchema } from "#src/internal/gen/coforge/rpc/v1/app_config_pb";
import { decodeAppConfigSync } from "./app-config";
import {
  APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
  decodeAppRegistrationNotice,
  encodeAppRegistrationNotice,
  type AppRegistrationNotice,
} from "./app-registration-notice";

const notice: AppRegistrationNotice = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  appKey: "acme-notes",
  appName: "Acme Notes",
  clientSecret: `cfa_secret_${"a".repeat(43)}`,
  messageType: APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
};

test("a notice round-trips", () => {
  expect(decodeAppRegistrationNotice(encodeAppRegistrationNotice(notice))).toEqual(notice);
});

test("a notice carrying something that is not a client secret is refused", () => {
  expect(() => encodeAppRegistrationNotice({ ...notice, clientSecret: "hunter2" })).toThrow();
  expect(() => encodeAppRegistrationNotice({ ...notice, agentId: "../x" })).toThrow();
});

test("other messages are not taken for a notice, and a notice is not taken for them", () => {
  const sync = toBinary(
    AppConfigSyncSchema,
    create(AppConfigSyncSchema, { protocolMajor: 1, messageType: "coforge.rpc.v1.AppConfigSync" }),
  );
  expect(() => decodeAppRegistrationNotice(sync)).toThrow();
  expect(() => decodeAppConfigSync(encodeAppRegistrationNotice(notice))).toThrow();
});

test("the daemon's other decoders refuse a notice's bytes", async () => {
  const { decodeReminderSync } = await import("./reminder");
  const { decodeAgentMigrationLease } = await import("./agent-migration");
  const bytes = encodeAppRegistrationNotice(notice);
  expect(() => decodeReminderSync(bytes)).toThrow();
  expect(() => decodeAgentMigrationLease(bytes)).toThrow();
});
