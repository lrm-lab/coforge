import { expect, test } from "bun:test";

import type { ForwardTarget } from "#src/features/conversations/message-forward";
import { assignTargetName } from "#src/features/tasks/board-assign-to";
import {
  canFileNewTask,
  defaultTarget,
  newTaskChoices,
  type NewTaskPlace,
} from "#src/features/tasks/board-new-task-dialog";

const channel = (
  name: string,
  { canSend = true, joined = true }: { canSend?: boolean; joined?: boolean } = {},
): ForwardTarget => ({
  kind: "channel",
  conversationId: `conversation-${name}`,
  name,
  visibility: "public",
  joined,
  canSend,
  members: [],
});

const place = (name: string): NewTaskPlace => ({
  conversationId: `conversation-${name}`,
  label: `#${name}`,
});

const person: ForwardTarget = {
  kind: "person",
  userId: "user-1",
  name: "Ada Lovelace",
  avatarUrl: null,
  joined: true,
  canSend: true,
};

const agent: ForwardTarget = {
  kind: "agent",
  agentId: "agent-1",
  name: "Reviewer Bot",
  handle: "reviewer",
  description: "",
  avatarUrl: "",
  joined: true,
  canSend: true,
};

test("a board that holds no Task offers no place of its own", () => {
  expect(newTaskChoices([]).places).toEqual([]);
});

test("the channels the board's Tasks were filed in come newest first", () => {
  const choices = newTaskChoices([
    {
      conversationId: "conversation-old",
      createdAt: "2026-11-01T00:00:00.000Z",
      source: { label: "#old", channelName: "old" },
    },
    {
      conversationId: "conversation-new",
      createdAt: "2026-11-09T00:00:00.000Z",
      source: { label: "#new", channelName: "new" },
    },
  ]);
  expect(choices.places.map((choice) => choice.label)).toEqual(["#new", "#old"]);
});

test("a board with no place of its own files into one of the viewer's channels", () => {
  expect(canFileNewTask([], [channel("general")])).toBe(true);
});

test("a channel the viewer cannot post in is no place, and neither is a person", () => {
  expect(canFileNewTask([], [channel("archive", { canSend: false })])).toBe(false);
  expect(canFileNewTask([], [person])).toBe(false);
  expect(canFileNewTask([], [])).toBe(false);
});

test("a channel the viewer has not joined is still a place, joined on first use", () => {
  expect(canFileNewTask([], [channel("launch", { joined: false })])).toBe(true);
});

test("a new Task goes where the board last filed one, not to the first channel", () => {
  const targets = [channel("general"), channel("launch")];
  expect(defaultTarget([place("launch")], targets)).toMatchObject({
    conversationId: "conversation-launch",
  });
  expect(defaultTarget([], targets)).toMatchObject({ conversationId: "conversation-general" });
});

test("a place the viewer can no longer post in is skipped, and so is an archived channel", () => {
  expect(
    defaultTarget(
      [place("archive"), place("launch")],
      [channel("archive", { canSend: false }), channel("launch")],
    ),
  ).toMatchObject({ conversationId: "conversation-launch" });
  expect(defaultTarget([], [channel("archive", { canSend: false })])).toBeUndefined();
});

test("assignTargetName formats people with humanLabel without @ and Agents with @handle", () => {
  expect(assignTargetName(channel("general"))).toBe("general");
  expect(assignTargetName(person)).toBe("Ada Lovelace");
  expect(assignTargetName(agent)).toBe("@reviewer");
});
