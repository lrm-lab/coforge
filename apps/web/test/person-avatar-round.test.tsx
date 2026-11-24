import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";

test("person uploaded photo uses circular avatar-person without portrait outline override", () => {
  const html = renderToStaticMarkup(
    <ActorAvatar
      presence={false}
      size="lg"
      userId="user-1"
      name="Jing"
      src="https://example.com/uploads/jing-photo.jpg"
    />,
  );
  expect(html).toContain("avatar-person");
  expect(html).not.toContain("avatar-round");
  expect(html).not.toContain("avatar-portrait");
  expect(html).toContain("rounded-full");
});

test("person default cartoon portrait keeps both avatar-person and avatar-portrait", () => {
  const html = renderToStaticMarkup(
    <ActorAvatar presence={false} size="lg" userId="user-1" name="Jing" src={null} />,
  );
  expect(html).toContain("avatar-person");
  expect(html).toContain("avatar-portrait");
  expect(html).not.toContain("avatar-round");
});

test("explicit rounded avatar uses avatar-round separately from avatar-person", () => {
  const html = renderToStaticMarkup(
    <ActorAvatar
      presence={false}
      size="2xl"
      name="Jing"
      src="https://example.com/uploads/jing-photo.jpg"
      rounded
    />,
  );
  expect(html).toContain("avatar-round");
  expect(html).not.toContain("avatar-person");
  expect(html).not.toContain("avatar-portrait");
});

test("non-person uploaded photo (agent or app) keeps rounded-square shape", () => {
  const html = renderToStaticMarkup(
    <ActorAvatar
      presence={false}
      size="lg"
      name="Bot"
      src="https://example.com/uploads/bot-photo.jpg"
    />,
  );
  expect(html).not.toContain("avatar-person");
  expect(html).not.toContain("avatar-round");
  expect(html).not.toContain("avatar-portrait");
});
