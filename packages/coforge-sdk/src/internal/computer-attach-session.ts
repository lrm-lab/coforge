import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  ComputerAttachCapabilitiesSchema,
  ComputerAttachErrorSchema,
  ComputerAttachSessionCompleteRequestSchema,
  ComputerAttachSessionCompleteResponseSchema,
  ComputerAttachSessionCreateRequestSchema,
  ComputerAttachSessionCreateResponseSchema,
  ComputerAttachSessionPollRequestSchema,
  ComputerAttachSessionPollResponseSchema,
  ComputerAttachSessionPreflightResponseSchema,
} from "./gen/coforge/rpc/v1/computer_attach_pb";

export {
  ComputerAttachCapabilitiesSchema,
  ComputerAttachErrorCode,
  ComputerAttachErrorSchema,
  ComputerAttachSessionCompleteRequestSchema,
  ComputerAttachSessionCompleteResponseSchema,
  ComputerAttachSessionCreateRequestSchema,
  ComputerAttachSessionCreateResponseSchema,
  ComputerAttachSessionIntent,
  ComputerAttachSessionPollRequestSchema,
  ComputerAttachSessionPollResponseSchema,
  ComputerAttachSessionPreflightResponseSchema,
  ComputerAttachSessionState,
  type ComputerAttachSessionCompleteRequest,
  type ComputerAttachSessionCreateRequest,
} from "./gen/coforge/rpc/v1/computer_attach_pb";

export const COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR = 1;

export const COMPUTER_ATTACH_SESSIONS_PATH = "/api/computer/attach/sessions";

function codec<Schema extends DescMessage>(schema: Schema) {
  return {
    encode: (value: MessageInitShape<Schema>) => toBinary(schema, create(schema, value)),
    decode: (bytes: Uint8Array) => fromBinary(schema, bytes),
  };
}

export const computerAttachWire = {
  capabilities: codec(ComputerAttachCapabilitiesSchema),
  error: codec(ComputerAttachErrorSchema),
  createRequest: codec(ComputerAttachSessionCreateRequestSchema),
  createResponse: codec(ComputerAttachSessionCreateResponseSchema),
  pollRequest: codec(ComputerAttachSessionPollRequestSchema),
  pollResponse: codec(ComputerAttachSessionPollResponseSchema),
  completeRequest: codec(ComputerAttachSessionCompleteRequestSchema),
  completeResponse: codec(ComputerAttachSessionCompleteResponseSchema),
  preflightResponse: codec(ComputerAttachSessionPreflightResponseSchema),
};
