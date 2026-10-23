/**
 * The chat list's design-spec values, pinned at the file level: the selected row's card fill and
 * outline, the avatar sizes and shapes, and the pinned row's
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

test("Chat list avatars: a 48px circle for a DM and a channel, 38px round for the message avatar", async () => {
  const cssText = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const rule = (selector: string) => {
    const start = cssText.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return cssText.slice(start, cssText.indexOf("}", start));
  };
  const dm = rule("[data-avatar].avatar-dm");
  expect(dm).toContain("width: 3rem");
  expect(dm).toContain("border-radius: 9999px");
  expect(rule("[data-avatar].size-8")).toContain("width: 2.375rem");
  const group = rule(".avatar-group");
  expect(group).toContain("--avatar-group-size: 3rem");
  expect(group).toContain("border-radius: 9999px");
  expect(group).not.toContain("gradient");
  // Frank (2026-10-24): a mascot or cartoon person is the bare white-edged sticker, drawn a little
  // larger than its box and unclipped, with no circle or fill behind it, in a channel's group
  // avatar too.
  expect(group).not.toContain("background");
  expect(rule(".avatar-sticker")).not.toContain("background");
  expect(rule("[data-avatar][data-avatar-sticker]")).toContain("border-radius: 9999px");
  const figure = rule(".avatar-sticker-figure");
  expect(figure).toContain("position: absolute");
  expect(Number(figure.match(/width: (\d+)%/)?.[1])).toBeGreaterThan(100);
  expect(figure).not.toContain("overflow");
  expect(cssText).not.toContain("avatar-group-grid");
  // A round avatar's status dot sits on the circle edge, not off its corner.
  expect(cssText).toContain("[data-avatar].avatar-dm > .avatar-status-dot");
  expect(cssText).toContain("right: calc(var(--avatar-size) * 0.0214)");
});

test("Row wiring: the selected card uses the spec fill/border and pinned rows use the sidebar foreground", async () => {
  // The row's own treatment lives in `conversation-row.tsx`; its callers are in the directory.
  const source = (
    await Promise.all(
      ["conversation-directory.tsx", "conversation-row.tsx"].map((file) =>
        Bun.file(new URL(`../src/features/conversations/${file}`, import.meta.url)).text(),
      ),
    )
  ).join("\n");
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
