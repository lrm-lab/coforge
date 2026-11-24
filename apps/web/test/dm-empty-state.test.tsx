import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ConversationStreamPlaceholder } from "#src/features/conversations/conversation-stream-placeholder";
import { m } from "#src/paraglide/messages";

test("DM empty state placeholder removes max-width and text-balance caps when singleLineDescription is set", () => {
  const html = renderToStaticMarkup(
    <ConversationStreamPlaceholder
      loading={false}
      narrow={false}
      emptyState={{
        title: "Chat with ada",
        description: m.conversation_empty_description(),
        singleLineDescription: true,
        media: <ActorAvatar presence={false} size="2xl" agentId="agent-1" name="ada" />,
      }}
    />,
  );
  expect(html).toContain("max-w-none");
  expect(html).toContain("text-wrap");
  expect(html).toContain("[&amp;&gt;p]:max-w-none");
  expect(html).not.toContain("ring-1");
  expect(html).not.toContain("ring-secondary");
});

test("default empty state placeholder preserves channel max-width and text-balance layout", () => {
  const html = renderToStaticMarkup(
    <ConversationStreamPlaceholder
      loading={false}
      narrow={false}
      emptyState={{
        title: "Welcome to #general",
        description: "This is the start of the channel.",
        media: <span />,
      }}
    />,
  );
  expect(html).not.toContain("max-w-none");
  expect(html).not.toContain("[&amp;&gt;p]:max-w-none");
  expect(html).toContain("max-w-lg");
  expect(html).toContain("max-w-sm");
});

test("human DM empty avatar renders circular without outer ring for uploaded and default photos", () => {
  const uploadedHtml = renderToStaticMarkup(
    <ActorAvatar
      presence={false}
      size="2xl"
      userId="user-1"
      name="Alex"
      src="https://example.com/uploads/alex.png"
    />,
  );
  expect(uploadedHtml).toContain("avatar-person");
  expect(uploadedHtml).not.toContain("ring-1");
  expect(uploadedHtml).not.toContain("ring-secondary");

  const defaultHtml = renderToStaticMarkup(
    <ActorAvatar presence={false} size="2xl" userId="user-2" name="Sam" />,
  );
  expect(defaultHtml).toContain("avatar-person");
  expect(defaultHtml).toContain("avatar-portrait");
  expect(defaultHtml).not.toContain("ring-1");
  expect(defaultHtml).not.toContain("ring-secondary");
});
