import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskNumberBadge, statusLabel } from "#src/features/tasks/task-status-icon";
import { storedTaskStatus } from "#src/server/tasks/task-view.server";

/**
 * A status a build does not know — a newer server's, met while an older bundle or instance is
 * still live in a rolling deploy — passes through reads and renders as its raw key with To do's
 * neutral ring, instead of failing the read or crashing the chip (task #61). The newer
 * vocabulary labels it properly once the bundle updates.
 */
test("storedTaskStatus passes an unknown status through and says so", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  try {
    const stored = storedTaskStatus("archived" as Parameters<typeof storedTaskStatus>[0], {
      number: 12,
    });
    expect(String(stored)).toBe("archived");
  } finally {
    console.warn = original;
  }
  const warning = warnings.find((line) => line.includes("unknown_status_passthrough"));
  expect(warning).toBeDefined();
  expect(warning).toContain('"status":"archived"');
  expect(warning).toContain('"taskNumber":12');
});

test("a status the bundle does not know renders as its raw key, with To do's ring", () => {
  const unknown = "archived" as Parameters<typeof statusLabel>[0];
  expect(statusLabel(unknown)).toBe("archived");
  // The badge draws without crashing, on To do's neutral colours, showing the label it was given.
  const markup = renderToStaticMarkup(
    <TaskNumberBadge number={12} status={unknown} label={statusLabel(unknown)} />,
  );
  expect(markup).toContain(">archived<");
  expect(markup).toContain("bg-utility-orange-50");
});
