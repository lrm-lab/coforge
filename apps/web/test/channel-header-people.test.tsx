import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CHANNEL_HEADER_FACE_LIMIT,
  ChannelHeaderFaces,
  type ChannelHeaderFace,
} from "#src/features/conversations/channel-header-people";
import { m } from "#src/paraglide/messages";

function faces(count: number): ChannelHeaderFace[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `user:${index}`,
    displayName: `Person ${index}`,
    avatarUrl: null,
  }));
}

test("The header keeps four faces and folds the rest into +N", () => {
  const markup = renderToStaticMarkup(
    <ChannelHeaderFaces
      entries={faces(6)}
      canAdd
      onOpenMembers={() => {}}
      onAddMembers={() => {}}
    />,
  );
  expect(CHANNEL_HEADER_FACE_LIMIT).toBe(4);
  expect(markup).toContain("Person 0");
  expect(markup).toContain("Person 3");
  expect(markup).not.toContain("Person 4");
  expect(markup).toContain("+2");
  expect(markup).toContain("flex items-center -space-x-2");
  expect(markup).toContain("size-6");
  expect(markup).not.toContain("size-8");
  expect(markup).toContain("bg-brand-primary text-brand-secondary *:text-brand-secondary");
  expect(markup).toContain(m.channel_settings_members_more({ count: 2 }));
  expect(markup).toContain(m.channel_settings_add_members());
});

test("A viewer who cannot invite does not get the add button", () => {
  const markup = renderToStaticMarkup(
    <ChannelHeaderFaces
      entries={faces(1)}
      canAdd={false}
      onOpenMembers={() => {}}
      onAddMembers={() => {}}
    />,
  );
  expect(markup).toContain("Person 0");
  expect(markup).not.toContain(m.channel_settings_add_members());
});

test("An empty roster with no invite renders nothing", () => {
  const markup = renderToStaticMarkup(
    <ChannelHeaderFaces
      entries={[]}
      canAdd={false}
      onOpenMembers={() => {}}
      onAddMembers={() => {}}
    />,
  );
  expect(markup).toBe("");
});
