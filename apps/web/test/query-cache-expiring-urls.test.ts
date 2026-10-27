import { expect, test } from "bun:test";

import { storedQueryData } from "#src/features/cache-persistence/persisted-queries";
import { savedMessagesQuery } from "#src/features/conversations/conversation-queries";

test("a kept copy holds neither of an attachment's 30-minute signed URLs", () => {
  const attachment = {
    id: "a1",
    fileName: "photo.png",
    previewUrl: "https://cdn.example/a1?sig",
    // The thumbnail is the same signature, so it expires with it (task #212).
    thumbnailUrl: "https://cdn.example/a1?sig&x-oss-process=thumbnail",
    iconUrl: "https://cdn.example/a1?sig&x-oss-process=icon",
    largeUrl: "https://cdn.example/a1?sig&x-oss-process=large",
  };
  const stored = JSON.stringify(
    storedQueryData(savedMessagesQuery("w1").queryKey, {
      streamPositions: {},
      entries: [{ message: { id: "m0", attachments: [attachment] } }],
    }),
  );
  expect(stored).toContain("photo.png");
  expect(stored).not.toContain("previewUrl");
  expect(stored).not.toContain("x-oss-process");
});
