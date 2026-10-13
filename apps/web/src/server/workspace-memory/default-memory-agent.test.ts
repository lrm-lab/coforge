import { expect, test } from "bun:test";
import { createDefaultWorkspaceMemoryProfile, type WorkspaceMemoryProfile } from "./profile";
import {
  computerIdToBind,
  earliestLinkedComputerId,
  profileForNewMemoryAgent,
  retriedOpenVikingProfile,
  type WorkspaceComputerLink,
} from "./default-memory-agent";

const now = new Date("2026-10-13T06:00:00.000Z");
const enabled = { prototypeEnabled: true };
const disabled = { prototypeEnabled: false };

function offProfile(): WorkspaceMemoryProfile {
  return createDefaultWorkspaceMemoryProfile("ws-a");
}

test("a closed prototype gate records the rejection and leaves the profile off", () => {
  const next = profileForNewMemoryAgent(offProfile(), now, disabled);
  expect(next.desired).toBe("off");
  expect(next.activationCursor).toBeNull();
  expect(next.sanitizedFailure?.code).toBe("prototype_disabled");
});

test("an open prototype gate selects openviking and sets the activation cursor", () => {
  const next = profileForNewMemoryAgent(offProfile(), now, enabled);
  expect(next.desired).toBe("openviking");
  expect(next.observed).toBe("provisioning");
  expect(next.activationCursor).toEqual({ kind: "time", occurredAt: now.toISOString() });
  expect(next.sanitizedFailure).toBeNull();
});

test("provisioning again does not move an openviking cursor", () => {
  const current = profileForNewMemoryAgent(offProfile(), now, enabled);
  const later = new Date("2026-10-13T07:00:00.000Z");
  const next = profileForNewMemoryAgent(current, later, enabled);
  expect(next).toBe(current);
});

test("the recorded rejection is retried when the gate opens", () => {
  const rejected = profileForNewMemoryAgent(offProfile(), now, disabled);
  expect(retriedOpenVikingProfile(rejected, now, disabled)).toBeNull();
  const later = new Date("2026-10-13T08:00:00.000Z");
  const retried = retriedOpenVikingProfile(rejected, later, enabled);
  expect(retried?.desired).toBe("openviking");
  expect(retried?.activationCursor?.occurredAt).toBe(later.toISOString());
});

test("a profile that is already openviking is not retried", () => {
  const current = profileForNewMemoryAgent(offProfile(), now, enabled);
  expect(retriedOpenVikingProfile(current, now, enabled)).toBeNull();
});

const earlier: WorkspaceComputerLink = {
  linkId: "link-b",
  computerId: "computer-early",
  linkedAt: new Date("2026-10-13T01:00:00.000Z"),
};
const later: WorkspaceComputerLink = {
  linkId: "link-a",
  computerId: "computer-late",
  linkedAt: new Date("2026-10-13T02:00:00.000Z"),
};

test("the earliest workspace link is the computer that gets bound", () => {
  expect(earliestLinkedComputerId([])).toBeNull();
  expect(earliestLinkedComputerId([later, earlier])).toBe("computer-early");
  expect(
    earliestLinkedComputerId([
      { ...earlier, linkId: "link-b", computerId: "computer-b" },
      { ...earlier, linkId: "link-a", computerId: "computer-a" },
    ]),
  ).toBe("computer-a");
});

test("a later computer does not replace one already bound", () => {
  expect(computerIdToBind(null, [later, earlier])).toBe("computer-early");
  expect(computerIdToBind("computer-kept", [earlier])).toBeNull();
  expect(computerIdToBind(null, [])).toBeNull();
});
