import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeConfig } from "@coforge/agent";
import { AgentInboxCoordinator } from "#src/daemon-runtime/agent-inbox-coordinator";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentAppInboxPersistence } from "#src/persistence/agent-app-inbox-store";
import { FileAppNotifiedStore } from "#src/persistence/app-notified-store";
import { sessionSpy } from "./fixtures/session-spy";
import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";

const roots: string[] = [];
const reminderId = "123e4567-e89b-42d3-a456-426614174000";
const due = (revision = "1") => ({
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: reminderId, revision },
  title: "Review release",
  summary: "Reminder is due",
});
function root() {
  const value = join(tmpdir(), `coforge-app-inbox-${crypto.randomUUID()}`);
  roots.push(value);
  return value;
}
afterEach(() =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("AgentAppInbox", () => {
  test("rejects unknown registry entries, invalid source refs, and unsafe previews", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    await expect(inbox.upsert({ ...due(), appId: "unknown" })).rejects.toThrow(
      "unknown App Inbox app",
    );
    await expect(inbox.upsert({ ...due(), notificationClass: "unknown" })).rejects.toThrow(
      "unknown App Inbox class",
    );
    await expect(
      inbox.upsert({ ...due(), sourceRef: { kind: "reminder", id: "../bad", revision: "1" } }),
    ).rejects.toThrow("UUID");
    await expect(inbox.upsert({ ...due(), title: "line one\nline two" })).rejects.toThrow(
      "single-line",
    );
    await expect(inbox.upsert({ ...due(), summary: "x".repeat(121) })).rejects.toThrow(
      "single-line",
    );
  });

  test("omits empty optional previews", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    const { title: _title, summary: _summary, ...withoutPreviews } = due();
    const item = await inbox.upsert({ ...withoutPreviews, title: "" });

    expect(item).not.toHaveProperty("title");
    expect(item).not.toHaveProperty("summary");
  });

  test("upserts stable identity while isolating reminder revisions and derives its action", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    const first = await inbox.upsert(due());
    const updated = await inbox.upsert({ ...due(), summary: "Updated" });
    await inbox.upsert(due("2"));
    expect(updated.itemId).toBe(first.itemId);
    expect(inbox.list()).toHaveLength(2);
    expect(
      inbox
        .list()
        .map((item) => item.itemId)
        .sort(),
    ).toEqual([`reminder:${reminderId}:1`, `reminder:${reminderId}:2`]);
    expect(updated).toMatchObject({
      retention: "until_explicit_ack",
      action: { kind: "run_command", commandId: "reminder.ack" },
    });
    expect(updated).not.toHaveProperty("messageId");
    expect(updated).not.toHaveProperty("argv");
  });

  test("restores durable items after restart without a generic acknowledgement", async () => {
    const directory = root();
    const inbox = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    const item = await inbox.upsert(due());
    const restored = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    expect(restored.list()).toEqual([item]);
    expect(restored.list()).toEqual([item]);
  });

  test("keeps a transient System Cleaner item in memory only", async () => {
    const directory = root();
    const inbox = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    const durable = await inbox.upsert(due());
    const transient = await inbox.upsert({
      appId: "system.cleaner",
      notificationClass: "memory_size",
      sourceRef: { kind: "memory_size", id: "agent-a", revision: "3" },
      title: "MEMORY.md is 70.0 KiB, over 64.0 KiB; recheck in 1h",
      summary: `Keep an index; move details into notes/; remove what is out of date. ${"x".repeat(100)}`,
    });
    expect(transient).toMatchObject({
      itemId: "cleaner:memory_size:agent-a",
      retention: "transient",
    });
    expect(inbox.list().map((item) => item.itemId)).toContain(transient.itemId);

    const path = join(directory, "app-inbox", "workspace-a", "agent-a", "items.json");
    const persisted = JSON.parse(await Bun.file(path).text()) as { items: { itemId: string }[] };
    expect(persisted.items.map((item) => item.itemId)).toEqual([durable.itemId]);
    const restored = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    expect(restored.list()).toEqual([durable]);

    expect(await inbox.remove(transient.itemId)).toBe(true);
    expect(inbox.list()).toEqual([durable]);
  });

  test("fails explicitly for corrupt persistence and unsafe path scopes", async () => {
    const directory = root();
    const path = join(directory, "app-inbox", "workspace-a", "agent-a", "items.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not-json");
    await expect(AgentAppInbox.open(directory, "workspace-a", "agent-a")).rejects.toThrow(
      "corrupt",
    );
    await expect(AgentAppInbox.open(directory, "../workspace", "agent-a")).rejects.toThrow(
      "path scope",
    );
  });
});

describe("AgentAppInbox commands", () => {
  test("each built-in class carries the command that acts on its item", async () => {
    const inbox = await AgentAppInbox.open(root(), "workspace-a", "agent-a");
    expect((await inbox.upsert(due("2"))).command).toBe(
      `coforge reminder ack --id ${reminderId} --revision 2`,
    );
    expect(
      (
        await inbox.upsert({
          appId: "system.app_registry",
          notificationClass: "client_secret",
          sourceRef: { kind: "app_registration", id: "acme-notes", revision: "1" },
          summary: "secret shown once",
        })
      ).command,
    ).toBe("coforge app rotate-secret --client acme-notes --output <new file>");
  });

  test("a restored item recomputes its command from the class, not from the file", async () => {
    const directory = root();
    const inbox = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    await inbox.upsert(due("3"));
    const reopened = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
    expect(reopened.list()[0]!.command).toBe(
      `coforge reminder ack --id ${reminderId} --revision 3`,
    );
  });
});

test("one-shot publication can retry after restart and a concurrent read without reminting", async () => {
  const directory = root();
  const workspace = "workspace-a";
  let inbox = await AgentAppInbox.open(directory, workspace, "agent-a");
  const input = {
    appId: "system.proc",
    notificationClass: "memory_limit",
    sourceRef: { kind: "proc_job", id: crypto.randomUUID(), revision: "1" },
    title: "Background job stopped at its memory cap",
  };
  await expect(
    inbox.publishOnce(input, async () => {
      throw new Error("crash before outbox commit");
    }),
  ).rejects.toThrow("crash before outbox commit");

  await inbox.upsert(due());
  const legacy = new AgentAppInboxPersistence(directory, workspace, "agent-a");
  expect((await legacy.read())?.map((item) => (item as { appId: string }).appId)).toEqual([
    "system.reminder",
  ]);
  await inbox.remove(`reminder:${reminderId}:1`);

  inbox = await AgentAppInbox.open(directory, workspace, "agent-a");
  const other = await AgentAppInbox.open(directory, workspace, "agent-b");
  expect(await other.read()).toEqual([]);
  const [item] = await inbox.read();
  expect(item?.sourceRef).toEqual(input.sourceRef);
  expect(item?.command).toBe("coforge proc list");

  inbox = await AgentAppInbox.open(directory, workspace, "agent-a");
  let committed = false;
  expect(
    await inbox.publishOnce(input, async () => {
      committed = true;
    }),
  ).toBeUndefined();
  expect(committed).toBe(true);
  expect(await inbox.read()).toEqual([]);
  const next = { ...input, sourceRef: { ...input.sourceRef, id: crypto.randomUUID() } };
  expect(await inbox.publishOnce(next, async () => {})).toMatchObject({
    sourceRef: next.sourceRef,
  });
  expect(await inbox.read()).toHaveLength(1);
  expect(await inbox.read()).toEqual([]);
});

test("a persisted proc notice waits even when a stopped Agent has a restart config", async () => {
  const directory = root();
  const workspaceId = "workspace-a";
  const agentId = "agent-a";
  const notices: string[] = [];
  let active = false;
  let starts = 0;
  const session = {
    ...sessionSpy(),
    notify: async (text: string) => {
      notices.push(text);
    },
  };
  const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
  const coordinator = new AgentInboxCoordinator({
    workspaceId,
    stateDirectory: directory,
    notifiedAppItems: new FileAppNotifiedStore(directory, workspaceId),
    consumedSeqs: new AgentConsumedSeqStore(directory),
    messageAttention: { check: () => [] },
    deliveryGate: new AgentDeliveryGate(),
    runtimeRelease: { isRecovering: () => false },
    processManager: {
      session: () => (active ? session : undefined),
      restartConfig: () => ({ config, sessionId: "session-a" }),
    },
    startAgent: async () => {
      starts++;
      return { config, session };
    },
    currentActivityLaunch: () => undefined,
    reconcileIdleTurn: () => false,
    mentionDeliveries: { settleRedelivery: () => {} },
    assertRunning: () => {},
    agentIdForContext: () => agentId,
  });
  const inbox = await coordinator.appInbox(agentId);
  await inbox.publishOnce(
    {
      appId: "system.proc",
      notificationClass: "memory_limit",
      sourceRef: { kind: "proc_job", id: crypto.randomUUID(), revision: "1" },
    },
    async () => {},
  );

  await coordinator.drainAppInboxNotices(agentId);
  expect(starts).toBe(0);
  expect(notices).toEqual([]);
  active = true;
  await coordinator.drainAppInboxNotices(agentId);
  await coordinator.drainAppInboxNotices(agentId);
  expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
  expect(await inbox.read()).toHaveLength(1);
  expect(await inbox.read()).toEqual([]);
  expect(starts).toBe(0);
});
