import { expect, test } from "bun:test";
import {
  decodeDaemonRuntimeCommandCodeEffortReadRequest,
  decodeDaemonRuntimeCommandCodeEffortReadResponse,
  encodeDaemonRuntimeCommandCodeEffortReadRequest,
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
} from "./command-code-effort-codec";
import {
  COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
  COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE,
} from "./index";

const request = {
  protocolMajor: 1,
  requestId: "effort-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  modelId: "deepseek/deepseek-v4-flash",
  messageType: COMMAND_CODE_EFFORT_READ_MESSAGE_TYPE,
};

test("Command Code effort read request round-trips", () => {
  expect(
    decodeDaemonRuntimeCommandCodeEffortReadRequest(
      encodeDaemonRuntimeCommandCodeEffortReadRequest(request),
    ),
  ).toEqual(request);
});

test("Command Code effort read response round-trips and keeps an empty list", () => {
  const ready = {
    protocolMajor: 1,
    requestId: "effort-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    accepted: true,
    status: "ready",
    efforts: ["off", "high", "max"],
    messageType: COMMAND_CODE_EFFORT_READ_RESPONSE_MESSAGE_TYPE,
  };
  expect(
    decodeDaemonRuntimeCommandCodeEffortReadResponse(
      encodeDaemonRuntimeCommandCodeEffortReadResponse(ready),
    ),
  ).toEqual(ready);
  expect(
    decodeDaemonRuntimeCommandCodeEffortReadResponse(
      encodeDaemonRuntimeCommandCodeEffortReadResponse({
        ...ready,
        accepted: false,
        status: "failed",
        efforts: [],
      }),
    ).efforts,
  ).toEqual([]);
});
