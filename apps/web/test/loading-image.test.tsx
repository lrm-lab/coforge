import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ImageFrame, LoadingImage } from "#src/features/conversations/loading-image";
import { m } from "#src/paraglide/messages";

const frame = (status: "loading" | "loaded" | "failed") =>
  renderToStaticMarkup(
    <ImageFrame status={status} src="/a.png" alt="A photo" className="size-10 rounded-lg" />,
  );

test("while loading, a pulsing skeleton fills the frame and the image stays hidden", () => {
  const markup = frame("loading");
  expect(markup).toContain(`aria-hidden="true"`);
  expect(markup).toContain("motion-safe:animate-pulse");
  expect(markup).toContain("opacity-0");
  expect(markup).toContain(`alt="A photo"`);
  expect(markup).toContain("size-10");
});

test("once loaded, only the image remains, with its alt", () => {
  const markup = frame("loaded");
  expect(markup).not.toContain("animate-pulse");
  expect(markup).not.toContain("opacity-0");
  expect(markup).toContain(`alt="A photo"`);
});

test("a failed image is a labelled box in the same frame, never a skeleton", () => {
  const markup = frame("failed");
  expect(markup).toContain(`role="img"`);
  expect(markup).toContain(`aria-label="${m.conversation_image_failed()}"`);
  expect(markup).not.toContain("animate-pulse");
  expect(markup).not.toContain("<img");
  expect(markup).toContain("size-10");
});

test("LoadingImage starts in the loading state", () => {
  const markup = renderToStaticMarkup(<LoadingImage src="/a.png" alt="" />);
  expect(markup).toContain("motion-safe:animate-pulse");
  expect(markup).toContain(`src="/a.png"`);
});
