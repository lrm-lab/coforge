/**
 * The chat list's design-spec values, pinned at the file level: the selected row's card fill and
 * outline, the collage avatar's 1px violet frame with no inner separations, and the pinned row's
 * darker title wiring. The conversation directory itself needs the app shell, so its classes are
 * asserted against the module's source, which never drifts silently — a rename shows up as a
 * failing literal here.
 */
import { expect, test } from "bun:test";

test("The theme carries the selected row's fill and outline values", async () => {
  const css = await Bun.file(new URL("../src/styles/coforge-theme.css", import.meta.url)).text();
  expect(css).toContain("--color-chat-selected-bg: #f4f6fa");
  expect(css).toContain("--color-chat-selected-border: #e0e5e1".replace("e0e5e1", "e0e5f1"));
  expect(css).toContain("--color-sidebar-fg: #101319");
});

test("The collage avatar: 1px frame padding, no inner gaps or fill, radius adjusted to stay 12px outside", async () => {
  const cssText = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const frame = cssText.slice(
    cssText.indexOf(".avatar-group {"),
    cssText.indexOf(".avatar-group-grid"),
  );
  expect(frame).toContain("padding: 0.0625rem");
  expect(frame).toContain("border-radius: 0.75rem");
  const grid = cssText.slice(
    cssText.indexOf(".avatar-group-grid"),
    cssText.indexOf("[data-avatar] > :first-child"),
  );
  expect(grid).toContain("gap: 0");
  expect(grid).toContain("background: transparent");
  expect(grid).toContain("border-radius: 0.6875rem");
});

test("Row wiring: the selected card uses the spec fill/border and pinned rows use the sidebar foreground", async () => {
  const source = await Bun.file(
    new URL("../src/features/conversations/conversation-directory.tsx", import.meta.url),
  ).text();
  expect(source).toContain("bg-chat-selected-bg");
  expect(source).toContain("border-chat-selected-border");
  expect(source).toContain("text-sidebar-fg");
  expect(source).toContain("pinned={channel.pinned}");
  expect(source).toContain("pinned={pinned}");
  // A direct message's selected row is the same card as a channel's: no second treatment.
  expect(source.match(/^\s+card$/gm)).toHaveLength(2);
  // The old selected treatment is gone from the directory.
  expect(source).not.toContain('border-secondary" : "border-transparent');
});
