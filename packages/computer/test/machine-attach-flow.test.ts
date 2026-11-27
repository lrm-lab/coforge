import { expect, test } from "bun:test";
import { createAttachKeyPair } from "@lrm/coforge-sdk/internal/computer-attach-proof";
import { ComputerAttachSessionState } from "@lrm/coforge-sdk/internal/computer-attach-session";
import { runMachineAttach } from "#src/setup/machine-attach-flow";
import type { PendingMachineAttach } from "#src/setup/machine-attach-secrets";

test("persists only protected handshake state and returns a binding after verified preflight", async () => {
  const sessionId = crypto.randomUUID();
  const binding = {
    computerId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    workspaceSlug: "team",
  };
  const events: string[] = [];
  const apiKey = "test-only-key";
  let pending: PendingMachineAttach | null = null;
  const flow = {
    serverUrl: "https://example.test",
    workspaceSlug: "team",
    metadata: {
      name: "Fixture",
      machineId: "physical",
      platform: "linux" as const,
      osVersion: "1",
      computerVersion: "1",
      displayName: "Fixture",
    },
    hostname: "fixture.example",
    show: () => {},
    secrets: {
      identity: async () => {
        const created = await createAttachKeyPair();
        return { publicKey: created.publicKey, privateKey: created.secretKey };
      },
      loadPending: async () => pending,
      savePending: async (_: string, value: PendingMachineAttach) => {
        pending = value;
      },
      clearPending: async () => {
        pending = null;
      },
    },
    client: {
      open: async () => ({
        sessionId,
        pollSecret: "test-only-poll",
        userCode: "T3STC0DE",
        verificationUri: `https://example.test/computers/attach/${sessionId}`,
        expiresInSeconds: 600,
        pollIntervalSeconds: 3,
      }),
      poll: async () => ({
        state: ComputerAttachSessionState.APPROVED,
        challenge: {
          nonce: "fixture-nonce",
          attachTicket: "fixture-ticket",
          expiresInSeconds: 300,
        },
      }),
      complete: async () => {
        events.push("complete");
        return { ...binding, apiKey, resumed: false };
      },
      preflight: async () => {
        events.push("preflight");
        expect(pending?.binding).toEqual(binding);
        expect(JSON.stringify(pending)).not.toContain(apiKey);
        if (events.length === 2) throw new Error("fixture cannot reach preflight");
        return binding;
      },
    },
  };

  await expect(runMachineAttach(flow)).rejects.toThrow("fixture cannot reach preflight");
  expect(events).toEqual(["complete", "preflight"]);
  const result = await runMachineAttach(flow);
  expect(result).toMatchObject({ ...binding, apiKey });
  expect(events).toEqual(["complete", "preflight", "complete", "preflight"]);
});
