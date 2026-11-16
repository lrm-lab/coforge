import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FilePane,
  FilePreviewError,
} from "#src/features/agents/profile-panel/agent-workspace-file-pane";
import { sameEntries, sameFileRead } from "#src/features/agents/profile-panel/agent-workspace-same";

/**
 * On a narrow panel an open file replaces the tree, so the back control in the pane's bar is the
 * only way out. It has to be there whatever the pane is showing: the text viewer loading (the
 * viewer is a lazy chunk, so this is its Suspense fallback), and the viewer failing, which leaves
 * no bar of its own.
 */
const back = <span data-testid="back">back</span>;

const readyText = {
  status: "ready" as const,
  path: "notes/plan.md",
  result: {
    status: "ok",
    sizeBytes: 5,
    modifiedAtMs: 1,
    text: "hello",
    contentType: "",
    contentBase64: "",
  } as never,
};

test("the back control is there while the file is loading", () => {
  const html = renderToStaticMarkup(
    <FilePane
      state={{ status: "loading", path: "notes/plan.md" }}
      onRetry={() => {}}
      leading={back}
    />,
  );
  expect(html).toContain('data-testid="back"');
  expect(html).toContain("plan.md");
});

test("the back control is there while the viewer's code loads", () => {
  const html = renderToStaticMarkup(
    <FilePane state={readyText} onRetry={() => {}} leading={back} />,
  );
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('data-testid="back"');
});

test("the back control is there when the viewer fails", () => {
  const html = renderToStaticMarkup(<FilePreviewError name="plan.md" leading={back} />);
  expect(html).toContain('data-testid="back"');
  expect(html).toContain('role="alert"');
});

test("without a back control (the split layout) the error view draws no bar", () => {
  const html = renderToStaticMarkup(<FilePreviewError name="plan.md" />);
  expect(html).not.toContain("plan.md");
  expect(html).toContain('role="alert"');
});

test("a quiet refresh keeps the object on screen when nothing changed", () => {
  const entry = { name: "a.md", type: "file" as const, sizeBytes: 1, modifiedAtMs: 2 };
  expect(sameEntries([entry], [{ ...entry }])).toBe(true);
  expect(sameEntries([entry], [{ ...entry, modifiedAtMs: 3 }])).toBe(false);
  expect(sameEntries([entry], [])).toBe(false);
  const read = readyText.result as Parameters<typeof sameFileRead>[0];
  expect(sameFileRead(read, { ...read })).toBe(true);
  expect(sameFileRead(read, { ...read, text: "hello!" })).toBe(false);
  expect(sameFileRead(read, { ...read, contentBase64: "AA==" })).toBe(false);
});

test("a file deleted since it was opened says it is gone, with nothing to retry", () => {
  const html = renderToStaticMarkup(
    <FilePane state={{ status: "missing", path: "notes/plan.md" }} onRetry={() => {}} />,
  );
  expect(html).toContain("no longer here");
  expect(html).not.toContain("Retry");
});
