import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentAppInboxSeals } from "#src/agent-app-inbox/app-inbox-seals";
import {
  AgentInboxCoordinator,
  type AgentInboxCoordinator as InboxCoordinator,
} from "#src/daemon-runtime/agent-inbox-coordinator";
import {
  sealReminder,
  sealedReminderConflict,
} from "#src/daemon-runtime/runtime-agent-api-reminder-seals";
import type { LocalReminderRequest } from "@lrm/coforge-sdk/internal";

const roots: string[] = [];
const reminderId = "123e4567-e89b-42d3-a456-426614174000";
function root() {
  const value = join(tmpdir(), `coforge-reminder-seals-${crypto.randomUUID()}`);
  roots.push(value);
  return value;
}
afterEach(() =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

const sealRequest = (over: Partial<LocalReminderRequest> = {}): LocalReminderRequest =>
  ({
    idempotencyKey: "request",
    context: "context",
    operation: "seal",
    reminderId,
    owner: "@ada",
    until: "the deploy lands",
    ...over,
  }) as LocalReminderRequest;

/** The daemon's ports for these operations: the App Inbox's live revisions and the seal store. */
function ports(stateDirectory = root(), live: string[] = ["3"]) {
  const seals = AgentAppInboxSeals.open(stateDirectory, "workspace-a", "agent-a");
  return {
    stateDirectory,
    seals,
    ports: {
      inboxCoordinator: {
        appSeals: async () => seals,
        appItemRevisions: async () => live,
      } as unknown as InboxCoordinator,
    },
  };
}

describe("AgentAppInboxSeals", () => {
  test("seals a source identity, survives a reopen, and unseals only what matches", async () => {
    const directory = root();
    const seals = await AgentAppInboxSeals.open(directory, "workspace-a", "agent-a");
    expect(
      await seals.seal([
        {
          appId: "system.reminder",
          notificationClass: "due",
          sourceKind: "reminder",
          sourceId: reminderId,
          sourceRevision: "3",
          owner: "@ada",
          until: "the deploy lands",
        },
      ]),
    ).toBe(1);

    const reopened = await AgentAppInboxSeals.open(directory, "workspace-a", "agent-a");
    expect(reopened.list()).toMatchObject([
      { sourceId: reminderId, sourceRevision: "3", owner: "@ada" },
    ]);

    expect(await reopened.unseal((seal) => seal.sourceRevision === undefined)).toBe(0);
    expect(await reopened.unseal((seal) => seal.sourceRevision === "3")).toBe(1);
    expect(reopened.list()).toEqual([]);
  });

  test("refuses a seal without an owner, a condition, or a positive revision", async () => {
    const seals = await AgentAppInboxSeals.open(root(), "workspace-a", "agent-a");
    const entry = {
      appId: "system.reminder",
      notificationClass: "due",
      sourceKind: "reminder",
      sourceId: reminderId,
      sourceRevision: "3",
      owner: "@ada",
      until: "the deploy lands",
    };
    await expect(seals.seal([{ ...entry, owner: " " }])).rejects.toThrow("owner");
    await expect(seals.seal([{ ...entry, until: "" }])).rejects.toThrow("condition");
    await expect(seals.seal([{ ...entry, sourceRevision: "0" }])).rejects.toThrow("revision");
  });
});

describe("reminder seals", () => {
  test("seal --revision names that revision, and seal without one names the source alone", async () => {
    const { ports: daemon } = ports();
    expect(await sealReminder(daemon, "agent-a", sealRequest({ revision: 3 }))).toMatchObject({
      accepted: true,
      sealed: 1,
    });
    expect(await sealReminder(daemon, "agent-a", sealRequest())).toMatchObject({
      accepted: true,
      sealed: 1,
    });
    const seals = await (await daemon.inboxCoordinator.appSeals("agent-a")).list();
    expect(seals.map((seal) => seal.sourceRevision)).toEqual([undefined, "3"]);
  });

  test("seal --all-pending takes every live revision the App Inbox holds", async () => {
    const { ports: daemon } = ports(root(), ["4"]);
    expect(await sealReminder(daemon, "agent-a", sealRequest({ allPending: true }))).toMatchObject({
      accepted: true,
      sealed: 1,
    });
    expect((await (await daemon.inboxCoordinator.appSeals("agent-a")).list())[0]).toMatchObject({
      sourceRevision: "4",
    });
  });

  test("--all-pending with nothing live says so instead of sealing nothing", async () => {
    const { ports: daemon } = ports(root(), []);
    expect(await sealReminder(daemon, "agent-a", sealRequest({ allPending: true }))).toEqual({
      accepted: false,
      reason: "no-live-revision",
      reminderId,
    });
  });

  test("unseal removes the id-only seal, one revision, or every seal for the id", async () => {
    const { ports: daemon } = ports();
    await sealReminder(daemon, "agent-a", sealRequest());
    await sealReminder(daemon, "agent-a", sealRequest({ revision: 3 }));
    await sealReminder(daemon, "agent-a", sealRequest({ revision: 4 }));

    expect(
      await sealReminder(daemon, "agent-a", sealRequest({ operation: "unseal" })),
    ).toMatchObject({ accepted: true, sealed: 1 });
    expect(
      await sealReminder(daemon, "agent-a", sealRequest({ operation: "unseal", revision: 3 })),
    ).toMatchObject({ accepted: true, sealed: 1 });
    expect(
      await sealReminder(daemon, "agent-a", sealRequest({ operation: "unseal", allPending: true })),
    ).toMatchObject({ accepted: true, sealed: 1 });
    expect(
      await sealReminder(daemon, "agent-a", sealRequest({ operation: "unseal", allPending: true })),
    ).toEqual({ accepted: false, reason: "no-matching-seal", reminderId });
  });

  test("a sealed reminder's lifecycle change is refused with who sealed it and until when", async () => {
    const { ports: daemon } = ports();
    expect(await sealedReminderConflict(daemon, "agent-a", reminderId)).toBeUndefined();
    await sealReminder(daemon, "agent-a", sealRequest({ revision: 3 }));
    expect(await sealedReminderConflict(daemon, "agent-a", reminderId)).toEqual({
      accepted: false,
      reason: "sealed",
      owner: "@ada",
      until: "the deploy lands",
      reminderId,
    });
  });
});

describe("inbox check seal states", () => {
  const coordinator = (stateDirectory: string) =>
    new AgentInboxCoordinator({
      workspaceId: "workspace-a",
      stateDirectory,
      messageAttention: { check: () => [] },
      assertRunning: () => {},
      agentIdForContext: (_context: string) => "agent-a",
    } as never);

  const inbox = (instance: AgentInboxCoordinator) =>
    instance.inbox("context", {
      idempotencyKey: "request",
      context: "context",
      operation: "check",
    });

  test("reports SEALED, STALE, DETACHED(id-only) and DETACHED(no-live-item)", async () => {
    const directory = root();
    const seals = await AgentAppInboxSeals.open(directory, "workspace-a", "agent-a");
    const base = {
      appId: "system.reminder",
      notificationClass: "due",
      sourceKind: "reminder",
      sourceId: reminderId,
      owner: "@ada",
      until: "the deploy lands",
    };
    await seals.seal([{ ...base, sourceRevision: "3" }]);
    await seals.seal([{ ...base, sourceRevision: "9" }]);
    await seals.seal([base]);

    const withItems = coordinator(directory);
    await (
      await withItems.appInbox("agent-a")
    ).upsert({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "3" },
      title: "Review release",
      summary: "Reminder due",
    });
    const live = await inbox(withItems);
    expect(
      live.seals.map((seal) => [seal.sourceRef.revision, seal.state, seal.liveRevision]),
    ).toEqual([
      [undefined, "DETACHED", "3"],
      ["3", "SEALED", "3"],
      ["9", "STALE", "3"],
    ]);

    const withoutItems = coordinator(directory);
    await (await withoutItems.appInbox("agent-a")).remove(`reminder:${reminderId}:3`);
    const gone = await inbox(withoutItems);
    expect(gone.seals.map((seal) => seal.state)).toEqual(["DETACHED", "DETACHED", "DETACHED"]);
  });
});
