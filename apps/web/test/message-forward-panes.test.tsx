import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ForwardTargetPane } from "#src/features/conversations/message-forward-panes";
import type { ForwardTarget } from "#src/features/conversations/message-forward";

const MEMBERS = [
  { kind: "user" as const, id: "u1", name: "Frank", avatarUrl: null },
  { kind: "agent" as const, id: "a1", name: "coforge-raft", avatarUrl: null },
];

function renderTargets(targets: readonly ForwardTarget[]) {
  return renderToStaticMarkup(
    <ForwardTargetPane
      query=""
      onQueryChange={() => {}}
      targets={targets}
      failed={new Map()}
      error={false}
      selected={new Map()}
      onToggle={() => {}}
    />,
  );
}

describe("ForwardTargetPane channel group avatars", () => {
  test("draws GroupAvatar for populated public and private channels, keeping the private lock beside the name", () => {
    const html = renderTargets([
      {
        kind: "channel",
        conversationId: "c-pub",
        name: "coforge",
        visibility: "public",
        members: MEMBERS,
        joined: true,
        canSend: true,
      },
      {
        kind: "channel",
        conversationId: "c-priv",
        name: "qa375-priv",
        visibility: "private",
        members: MEMBERS,
        joined: true,
        canSend: true,
      },
    ]);

    expect(html.match(/class="avatar-group avatar-group-xs"/g)?.length).toBe(2);
    expect(html).toContain(">coforge<");
    expect(html).not.toContain(">#coforge<");
    expect(html).toContain('role="img"');
    expect(html).toContain(">qa375-priv<");
  });

  test("falls back to the glyph tile without duplicating the lock on 0-member channels", () => {
    const html = renderTargets([
      {
        kind: "channel",
        conversationId: "c-empty-pub",
        name: "empty-public",
        visibility: "public",
        members: [],
        joined: false,
        canSend: true,
      },
      {
        kind: "channel",
        conversationId: "c-empty-priv",
        name: "empty-private",
        visibility: "private",
        members: [],
        joined: true,
        canSend: true,
      },
    ]);

    expect(html).not.toContain("avatar-group");
    expect(html).not.toContain('role="img"');
    expect(html).toContain(">empty-public<");
    expect(html).toContain(">empty-private<");
  });
});
