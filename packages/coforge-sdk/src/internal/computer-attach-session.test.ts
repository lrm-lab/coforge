import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import {
  ComputerAttachSessionIntent,
  ComputerAttachSessionState,
  ComputerAttachSessionCreateRequestSchema,
  ComputerAttachSessionCompleteResponseSchema,
  ComputerAttachSessionPollResponseSchema,
  ComputerAttachSessionPreflightResponseSchema,
} from "./computer-attach-session";

test("preserves the machine identity and an optional Workspace target at creation", () => {
  const request = create(ComputerAttachSessionCreateRequestSchema, {
    protocolMajor: 1,
    machineId: "machine",
    machineName: "Office",
    hostname: "office",
    platform: "linux",
    machinePublicKey: new Uint8Array(32).fill(80),
    workspaceSlug: "team",
    intent: ComputerAttachSessionIntent.ATTACH,
  });
  const roundTrip = fromBinary(
    ComputerAttachSessionCreateRequestSchema,
    toBinary(ComputerAttachSessionCreateRequestSchema, request),
  );

  expect(roundTrip).toEqual(request);
  expect(roundTrip.existingComputerId).toBeUndefined();
});

test("distinguishes approval from completing and does not require a ticket for a resume challenge", () => {
  const pending = create(ComputerAttachSessionPollResponseSchema, {
    state: ComputerAttachSessionState.AWAITING_APPROVAL,
  });
  const resumable = create(ComputerAttachSessionPollResponseSchema, {
    state: ComputerAttachSessionState.COMPLETING,
    challenge: { nonce: "fresh challenge", expiresInSeconds: 60 },
  });

  expect(
    fromBinary(
      ComputerAttachSessionPollResponseSchema,
      toBinary(ComputerAttachSessionPollResponseSchema, pending),
    ).challenge,
  ).toBeUndefined();
  const decoded = fromBinary(
    ComputerAttachSessionPollResponseSchema,
    toBinary(ComputerAttachSessionPollResponseSchema, resumable),
  );
  expect(decoded.challenge?.nonce).toBe("fresh challenge");
  expect(decoded.challenge?.attachTicket).toBeUndefined();
});

test("delivers a key only in complete and records binding identity after preflight", () => {
  const completed = create(ComputerAttachSessionCompleteResponseSchema, {
    computerId: "computer",
    workspaceId: "workspace",
    workspaceSlug: "team",
    apiKey: "test-only-placeholder",
    resumed: true,
  });
  const checked = create(ComputerAttachSessionPreflightResponseSchema, {
    computerId: "computer",
    workspaceId: "workspace",
    workspaceSlug: "team",
  });

  expect(
    fromBinary(
      ComputerAttachSessionCompleteResponseSchema,
      toBinary(ComputerAttachSessionCompleteResponseSchema, completed),
    ),
  ).toEqual(completed);
  expect(
    fromBinary(
      ComputerAttachSessionPreflightResponseSchema,
      toBinary(ComputerAttachSessionPreflightResponseSchema, checked),
    ),
  ).toEqual(checked);
  expect(Object.keys(checked)).not.toContain("apiKey");
});
