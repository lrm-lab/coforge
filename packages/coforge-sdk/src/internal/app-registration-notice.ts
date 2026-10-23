import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { boundedPayload } from "./codec";
import { isScopeId } from "./scope-id";
import {
  AppRegistrationNoticeSchema,
  type AppRegistrationNotice as WireNotice,
} from "#src/internal/gen/coforge/rpc/v1/app_registration_pb";

/**
 * The private, transient notice that hands a newly registered app's client secret to its owner
 * Agent (`app:register` card committed). It travels once on the daemon control channel to a daemon
 * that advertised `APP_REGISTRATION_NOTICE_CAPABILITY`, and is never stored by the cloud; an Agent
 * that misses it runs `coforge app rotate-secret`.
 */
export const APP_REGISTRATION_NOTICE_MESSAGE_TYPE = "coforge.rpc.v1.AppRegistrationNotice" as const;
export const APP_REGISTRATION_NOTICE_CAPABILITY = "app-registration-notice:v1" as const;
export const APP_REGISTRATION_NOTICE_PROTOCOL_MAJOR = 1 as const;

export type AppRegistrationNotice = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  appKey: string;
  appName: string;
  clientSecret: string;
  messageType: typeof APP_REGISTRATION_NOTICE_MESSAGE_TYPE;
};

const MAX_BYTES = 8_192;
const SECRET_PATTERN = /^cfa_secret_[A-Za-z0-9_-]{16,128}$/;

function checked(value: AppRegistrationNotice): AppRegistrationNotice {
  if (
    value.protocolMajor !== APP_REGISTRATION_NOTICE_PROTOCOL_MAJOR ||
    value.messageType !== APP_REGISTRATION_NOTICE_MESSAGE_TYPE ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId].some(
      (id) => !isScopeId(id),
    ) ||
    !value.appKey ||
    value.appKey.length > 64 ||
    value.appName.length === 0 ||
    value.appName.length > 200 ||
    !SECRET_PATTERN.test(value.clientSecret)
  )
    throw new Error("invalid app registration notice");
  return value;
}

export function encodeAppRegistrationNotice(value: AppRegistrationNotice): Uint8Array {
  checked(value);
  return boundedPayload(
    toBinary(AppRegistrationNoticeSchema, create(AppRegistrationNoticeSchema, value)),
    MAX_BYTES,
    "App registration notice",
  );
}

/** A notice as received; anything of another message type or shape is refused. */
export function decodeAppRegistrationNotice(bytes: Uint8Array): AppRegistrationNotice {
  const wire: WireNotice = fromBinary(
    AppRegistrationNoticeSchema,
    boundedPayload(bytes, MAX_BYTES, "App registration notice"),
  );
  return checked({
    protocolMajor: wire.protocolMajor,
    requestId: wire.requestId,
    workspaceId: wire.workspaceId,
    computerId: wire.computerId,
    agentId: wire.agentId,
    appKey: wire.appKey,
    appName: wire.appName,
    clientSecret: wire.clientSecret,
    messageType: wire.messageType as typeof APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
  });
}
