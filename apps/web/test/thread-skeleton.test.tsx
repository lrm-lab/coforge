import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadLoadStatus } from "#src/features/conversations/thread-root-state";
import { m } from "#src/paraglide/messages";

/**
 * A thread being read is drawn as its loaded pane is (task #169): the first message over its rule,
 * the reply count line, and replies, pulsing, under one status a screen reader announces as
 * loading. The Task popup, where the Task stands for the first message, draws the replies only.
 */
const noop = () => {};
const rows = (markup: string) => markup.match(/rounded-full/g)?.length ?? 0;

test("a loading thread is skeleton rows under one loading status", () => {
  const markup = renderToStaticMarkup(
    <ThreadLoadStatus load={{ status: "loading" }} onRetry={noop} />,
  );
  expect(markup).toContain(`role="status"`);
  expect(markup).toContain(`aria-label="${m.conversation_loading()}"`);
  expect(markup).toContain("motion-safe:animate-pulse");
  // The first message and three replies, each with its avatar.
  expect(rows(markup)).toBe(4);
  expect(markup).not.toContain('role="progressbar"');
});

test("the Task popup's loading thread leaves the first message to the Task", () => {
  const markup = renderToStaticMarkup(
    <ThreadLoadStatus load={{ status: "loading" }} withRoot={false} onRetry={noop} />,
  );
  expect(rows(markup)).toBe(3);
});

test("a failed or missing thread still says so, with its way on", () => {
  const failed = renderToStaticMarkup(
    <ThreadLoadStatus load={{ status: "failed" }} onRetry={noop} />,
  );
  expect(failed).toContain(m.conversation_thread_load_error());
  expect(failed).toContain(m.controls_retry());
  const missing = renderToStaticMarkup(
    <ThreadLoadStatus load={{ status: "missing" }} onClose={noop} onRetry={noop} />,
  );
  expect(missing.replaceAll("&#x27;", "'")).toContain(m.conversation_thread_unavailable());
});
