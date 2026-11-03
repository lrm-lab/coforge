import { expect, test } from "bun:test";
import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LaterEventDetail,
  laterEventTitle,
  type LaterHistoryEvent,
} from "#src/features/tasks/task-history-more";

const base = {
  id: "event-1",
  seq: 1,
  actorType: "user",
  actorName: "ada",
  createdAt: "2026-11-03T06:00:00.000Z",
} satisfies Partial<TaskHistoryEvent>;

const render = (event: LaterHistoryEvent) =>
  renderToStaticMarkup(<LaterEventDetail event={event} />);

test("names label changes and lists what was added and removed", () => {
  const event: LaterHistoryEvent = {
    ...base,
    eventType: "labels_changed",
    payload: {
      added: [
        { id: "a", name: "bug", color: "error" },
        { id: "b", name: "ui", color: "blue" },
      ],
      removed: [],
    },
  };
  expect(laterEventTitle(event)).toBeTruthy();
  const html = render(event);
  expect(html).toContain("bug, ui");
  expect(html.match(/<p/g)?.length).toBe(1);
});

test("shows a priority change from one level to another", () => {
  const event: LaterHistoryEvent = {
    ...base,
    eventType: "priority_changed",
    payload: { from: "none", to: "urgent" },
  };
  expect(laterEventTitle(event)).toBeTruthy();
  expect(render(event)).toMatch(/→/);
});

test("shows a Project change, with a dash for none", () => {
  const event: LaterHistoryEvent = {
    ...base,
    eventType: "project_changed",
    payload: { from: null, to: { id: "p", name: "Launch", slug: "launch" } },
  };
  expect(laterEventTitle(event)).toBeTruthy();
  const html = render(event);
  expect(html).toContain("—");
  expect(html).toContain("Launch");
});
