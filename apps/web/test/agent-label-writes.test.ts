import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { handleAgentLabelPost } from "#src/routes/api/agent/v1/labels";
import type { AgentLabelWriteServices } from "#src/server/tasks/agent-label-writes.server";
import type { LabelRow } from "#src/server/tasks/labels.server";

const PRINCIPAL = { workspaceId: "ws-1", agentId: "agent-1" };

const row = (over: Partial<LabelRow> = {}): LabelRow => ({
  id: "lbl-1",
  name: "Bug",
  color: "gray",
  description: "Something broken",
  groupId: null,
  archivedAt: null,
  group: null,
  ...over,
});

function services(found: LabelRow | null = row()) {
  const calls: unknown[] = [];
  const announced: string[] = [];
  const fake: AgentLabelWriteServices = {
    labels: {
      create: async (workspaceId, actor, input) => {
        calls.push({ create: { workspaceId, actor, input } });
        return row({ name: input.name, description: input.description ?? null });
      },
      update: async (workspaceId, actor, id, input) => {
        calls.push({ update: { workspaceId, actor, id, input } });
        return row({
          ...(input.name ? { name: input.name } : {}),
          ...(input.archived ? { archivedAt: new Date("2026-11-04T07:00:00.000Z") } : {}),
        });
      },
    },
    findByName: async () => found,
    announce: async (_workspaceId, label) => {
      announced.push(label.id);
    },
  };
  return { fake, calls, announced };
}

const post = (body: unknown) =>
  new Request("http://local/api/agent/v1/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("create makes the label as the Agent and announces it", async () => {
  const { fake, calls, announced } = services();
  const response = await handleAgentLabelPost(
    post({ operation: "create", name: "Bug", description: "Something broken", color: "error" }),
    PRINCIPAL,
    fake,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { label: { name: string } }).label.name).toBe("Bug");
  expect(calls).toEqual([
    {
      create: {
        workspaceId: "ws-1",
        actor: { agentId: "agent-1" },
        input: { name: "Bug", description: "Something broken", color: "error" },
      },
    },
  ]);
  expect(announced).toEqual(["lbl-1"]);
});

test("rename, recolor, delete and restore update the named label as the Agent", async () => {
  const { fake, calls } = services();
  const response = await handleAgentLabelPost(
    post({ operation: "update", label: "bug", archived: true }),
    PRINCIPAL,
    fake,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { label: { archivedAt: string } }).label.archivedAt).toBe(
    "2026-11-04T07:00:00.000Z",
  );
  expect(calls).toEqual([
    {
      update: {
        workspaceId: "ws-1",
        actor: { agentId: "agent-1" },
        id: "lbl-1",
        input: { archived: true },
      },
    },
  ]);
});

test("an unknown label name is NOT_FOUND and points at label list", async () => {
  const { fake, calls } = services(null);
  const response = await handleAgentLabelPost(
    post({ operation: "update", label: "Nope", name: "Other" }),
    PRINCIPAL,
    fake,
  );
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: string }).error).toContain("coforge label list");
  expect(calls).toEqual([]);
});

test("a malformed body or a blank description is INVALID_INPUT", async () => {
  const { fake, calls } = services();
  for (const body of [
    { operation: "update", label: "Bug" },
    { operation: "create", name: "Bug" },
    { operation: "create", name: "Bug", description: "  " },
  ]) {
    const response = await handleAgentLabelPost(post(body), PRINCIPAL, fake);
    expect(response.status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("a member Agent's rename is refused as the store refuses it", async () => {
  const { fake } = services();
  fake.labels.update = async () => {
    throw new AppError("ACCESS_DENIED");
  };
  const response = await handleAgentLabelPost(
    post({ operation: "update", label: "Bug", name: "Defect" }),
    PRINCIPAL,
    fake,
  );
  expect(response.status).toBe(403);
});

test("a failed page signal does not fail a write that landed", async () => {
  const { fake } = services();
  fake.announce = async () => {
    throw new Error("centrifugo down");
  };
  const response = await handleAgentLabelPost(
    post({ operation: "update", label: "Bug", color: "error" }),
    PRINCIPAL,
    fake,
  );
  expect(response.status).toBe(200);
});
