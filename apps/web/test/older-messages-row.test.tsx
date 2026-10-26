import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OlderMessagesRow, type OlderLoad } from "#src/features/conversations/older-messages-row";
import { m } from "#src/paraglide/messages";

/**
 * The row above the oldest loaded message (task #171): a spinner (still under reduced motion)
 * whose words are for screen readers only, a retry when the read failed, and the same height in
 * every state so the scroll anchor holds.
 */
const row = (load: OlderLoad) =>
  renderToStaticMarkup(
    <OlderMessagesRow rootRef={{ current: null }} loadedCount={40} load={load} onLoad={() => {}} />,
  );

test("loading older history is a spinner, its words for screen readers only", () => {
  const markup = row("loading");
  expect(markup).toContain(`<span class="sr-only">${m.conversation_loading_older()}</span>`);
  expect(markup).toContain(`aria-live="polite"`);
  expect(markup).toContain("motion-safe:animate-spin");
});

test("a failed read says so and offers a retry", () => {
  const markup = row("failed");
  expect(markup).toContain(m.conversation_load_older_failed());
  expect(markup).toContain(m.controls_retry());
  expect(markup).not.toContain("animate-spin");
});

test("the row keeps one height in every state", () => {
  for (const load of ["idle", "loading", "failed"] as const) expect(row(load)).toContain("h-8");
  expect(row("idle")).not.toContain(m.conversation_loading_older());
});
