import { expect } from "bun:test";
import type { agentWrites } from "./artifact-agent-writes";
import type { artifactChrome } from "./artifact-chrome";
import { cdpMod, createArtifactCopyDrivers, modKey } from "./artifact-markdown-copy-drivers";
import { browserSession, pageDevtools, pageHydrated } from "./browser-e2e";

export async function verifyArtifactMarkdownCopy(input: {
  session: ReturnType<typeof browserSession>;
  chrome: ReturnType<typeof artifactChrome>;
  bot: ReturnType<typeof agentWrites>;
  channelId: string;
  chatUrl: string;
  pageOf: (id: string, query?: string) => string;
  tail: string;
  excludedChatText: string;
}): Promise<string> {
  const { session, chrome, bot, channelId, chatUrl, pageOf, tail, excludedChatText } = input;
  const { browser, evaluate } = session;
  const {
    dragPoints,
    clickPoint,
    clickElement,
    readCopiedViaRealPaste,
    pressModAAndCheckIntercepted,
  } = createArtifactCopyDrivers(session);

  const doc = await bot.create({
    conversationId: channelId,
    title: "Launch plan",
    files: { "plan.md": `# Goal\n\nShip it (run ${tail}).\n` },
  });
  const richDocMarkdown = [
    `# Goal ${tail}`,
    "",
    `Ship it on Friday (run ${tail}) with $E = mc^2$.`,
    "",
    "$$",
    "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}",
    "$$",
    "",
    "## Plan",
    "",
    "- Prepare release notes",
    "- Verify rollout gates",
    "",
    "- [x] Done task item",
    "- [ ] Open follow-up item",
    "",
    "```ts",
    `const weekTag = "run-${tail}";`,
    "console.log(weekTag);",
    "```",
    "",
    "| Item | Owner |",
    "| --- | --- |",
    "| Release | Dev |",
    "",
    "```mermaid view=source",
    "graph LR",
    "  A[Read] --> B[Copy]",
    "```",
    "",
    "```html",
    '<div id="preview-card">Sandboxed card widget</div>',
    "```",
  ].join("\n");
  await bot.push(doc.id, 1, { "plan.md": richDocMarkdown });

  await browser("open", `${chatUrl}?doc=${doc.id}`);
  await browser(
    "wait",
    "--fn",
    `${pageHydrated} && document.querySelector('[data-artifact-preview] [data-artifact-markdown]')?.textContent.includes("Friday") && document.querySelectorAll('[data-artifact-preview] .katex-mathml').length >= 2`,
  );
  expect(await evaluate<string>("location.pathname")).toEndWith(`/channel/${channelId}`);

  await dragPoints(
    "[data-artifact-preview] [data-artifact-markdown] h1",
    "[data-artifact-preview] [data-artifact-markdown] p",
  );
  const paneDraggedText = await evaluate<string>(`window.getSelection()?.toString() ?? ""`);
  expect(paneDraggedText).toContain(`Goal ${tail}`);
  expect(paneDraggedText).toContain("Friday");

  await evaluate(
    `(document.querySelector("[data-artifact-preview] header [data-artifact-expand]")?.focus(), true)`,
  );
  const headerButtonModA = await pressModAAndCheckIntercepted();
  expect(headerButtonModA.intercepted).toBe(false);
  expect(
    headerButtonModA.inMarkdown && headerButtonModA.text.includes("Prepare release notes"),
  ).toBe(false);

  const previewHeaderPoint = await evaluate<{ x: number; y: number }>(`(() => {
    const header = document.querySelector("[data-artifact-preview] header");
    const hr = header.getBoundingClientRect();
    const spacer = header?.querySelector("span.flex-1");
    if (spacer) {
      const sr = spacer.getBoundingClientRect();
      if (sr.width >= 8) {
        return { x: Math.round(sr.left + sr.width / 2), y: Math.round(hr.top + hr.height / 2) };
      }
    }
    return { x: Math.round(hr.right - 2), y: Math.round(hr.top + 2) };
  })()`);
  await clickPoint(previewHeaderPoint.x, previewHeaderPoint.y);
  await evaluate(`(window.getSelection()?.removeAllRanges(), true)`);
  const previewHeaderWhitespaceModA = await pressModAAndCheckIntercepted();
  expect(previewHeaderWhitespaceModA.intercepted).toBe(false);

  const chatMessagePoint = await evaluate<{ x: number; y: number }>(`(() => {
    const needle = ${JSON.stringify(excludedChatText)};
    const row = [...document.querySelectorAll("li[data-message-id]")].find(
      (el) => el.textContent?.includes(needle) && !el.closest("[data-artifact-preview]"),
    );
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let targetEl = row;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(needle) && !node.parentElement?.closest("a, button")) {
        targetEl = node.parentElement;
        break;
      }
    }
    targetEl.scrollIntoView({ block: "center" });
    const r = targetEl.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) };
  })()`);
  await clickPoint(chatMessagePoint.x, chatMessagePoint.y);
  await evaluate(`(window.getSelection()?.removeAllRanges(), true)`);
  const chatModA = await pressModAAndCheckIntercepted();
  expect(chatModA.intercepted).toBe(false);

  await clickElement("[data-artifact-preview] [data-artifact-markdown] p");
  await evaluate(`(window.getSelection()?.removeAllRanges(), true)`);
  const paneSelectAll = await pressModAAndCheckIntercepted();
  expect(paneSelectAll.intercepted).toBe(true);
  expect(paneSelectAll.inMarkdown).toBe(true);
  expect(paneSelectAll.text).toContain("Prepare release notes");
  expect(paneSelectAll.text).not.toContain(excludedChatText);

  await browser("open", pageOf(doc.id));
  await browser(
    "wait",
    "--fn",
    `${pageHydrated} && document.querySelector("main [data-artifact-markdown]")?.textContent.includes("Friday") && document.querySelectorAll("main [data-artifact-markdown] .katex-mathml").length >= 2`,
  );
  expect(await evaluate<boolean>(`document.querySelector("main .ProseMirror") == null`)).toBe(true);
  expect(
    await evaluate<boolean>(`document.querySelector('main [contenteditable="true"]') == null`),
  ).toBe(true);
  expect(await chrome.versionChipText()).toBe("v2");

  const cdp = await pageDevtools(browser, `/artifacts/${doc.id}`);
  try {
    await dragPoints(
      "main [data-artifact-markdown] h1",
      "main [data-artifact-markdown] td:last-child",
      12,
    );
    await browser("wait", "--fn", `document.querySelector("[data-comment-selection]") != null`);
    const standaloneDrag = await evaluate<{ text: string; hasCommentOffer: boolean }>(`(() => ({
      text: window.getSelection()?.toString() ?? "",
      hasCommentOffer: document.querySelector("[data-comment-selection]") != null,
    }))()`);
    expect(standaloneDrag.text).toContain(`Goal ${tail}`);
    expect(standaloneDrag.text).toContain("Prepare release notes");
    expect(standaloneDrag.text).toContain("Done task item");
    expect(standaloneDrag.text).toContain(`const weekTag = "run-${tail}";`);
    expect(standaloneDrag.text).toContain("Release");
    expect(standaloneDrag.hasCommentOffer).toBe(true);

    const dragCopy = await readCopiedViaRealPaste(cdp);
    expect(dragCopy.html).toContain("<h1");
    expect(dragCopy.html).toContain("<ul");
    expect(dragCopy.html).toContain('data-type="taskList"');
    expect(dragCopy.html).toContain('data-type="taskItem"');
    expect(dragCopy.html).toContain("<pre");
    expect(dragCopy.html).toContain("<table");
    expect(dragCopy.html).toContain('data-type="inline-math"');
    expect(dragCopy.html).toContain('data-type="block-math"');
    expect(dragCopy.html).not.toContain("data-anchor-chrome");
    expect(dragCopy.plain).toContain(`Goal ${tail}`);
    expect(dragCopy.plain).toContain("$E = mc^2$");
    expect(dragCopy.plain).toContain("$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$");
    expect(dragCopy.plain).toContain("Prepare release notes");
    expect(dragCopy.plain).toContain("[x] Done task item");
    expect(dragCopy.plain).toContain("[ ] Open follow-up item");
    expect(dragCopy.plain).toContain(`const weekTag = "run-${tail}";`);
    expect(dragCopy.plain).toContain("Release\tDev");
    expect(dragCopy.plain).not.toContain("Copy code");
    expect(dragCopy.plain).not.toContain("tsconst");
    expect(dragCopy.plain).not.toContain("Outline");
    expect(dragCopy.plain).not.toContain("Launch plan");

    await evaluate(
      `(document.querySelector("main header a")?.focus(), window.getSelection()?.removeAllRanges(), true)`,
    );
    const standaloneHeaderModA = await pressModAAndCheckIntercepted();
    expect(standaloneHeaderModA.intercepted).toBe(false);

    const initialMermaid = await evaluate<{
      hasSourceView: boolean;
      iframeCount: number;
      sourceHidden: boolean;
    }>(`(() => {
      const host = document.querySelector('main [data-artifact-markdown] [data-mermaid-view="source"]');
      const source = host?.querySelector(".artifact-markdown-code-source");
      return {
        hasSourceView: Boolean(host),
        iframeCount: host?.querySelectorAll("iframe.mermaid-diagram-frame").length ?? -1,
        sourceHidden: Boolean(source?.classList.contains("code-block-source-visually-hidden")),
      };
    })()`);
    expect(initialMermaid.hasSourceView).toBe(true);
    expect(initialMermaid.iframeCount).toBe(0);
    expect(initialMermaid.sourceHidden).toBe(false);

    const selectMermaidMode = async (label: string, expectedView: string) => {
      await evaluate(
        `(document.querySelector('main [data-artifact-markdown] [data-testid="code-block-mermaid-view"]')?.scrollIntoView({ block: "center" }), true)`,
      );
      await browser(
        "click",
        'main [data-artifact-markdown] [data-testid="code-block-mermaid-view"]',
      );
      await browser("wait", "--fn", `document.querySelector('[role="menu"]') != null`);
      await chrome.pressMenuItem(label);
      await browser(
        "wait",
        "--fn",
        `document.querySelector('main [data-artifact-markdown] [data-mermaid-view="${expectedView}"]') != null && document.querySelector('[role="menu"]') == null`,
      );
    };

    await selectMermaidMode("Diagram", "diagram");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main [data-artifact-markdown] [data-mermaid-view="diagram"] iframe.mermaid-diagram-frame') != null`,
    );
    expect(
      await evaluate<boolean>(
        `Boolean(document.querySelector('main [data-artifact-markdown] [data-mermaid-view="diagram"] .artifact-markdown-code-source.code-block-source-visually-hidden'))`,
      ),
    ).toBe(true);

    await selectMermaidMode("Split", "both");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main [data-artifact-markdown] [data-mermaid-view="both"] iframe.mermaid-diagram-frame') != null`,
    );
    expect(
      await evaluate<boolean>(
        `Boolean(document.querySelector('main [data-artifact-markdown] [data-mermaid-view="both"] .artifact-markdown-code-source:not(.code-block-source-visually-hidden)'))`,
      ),
    ).toBe(true);

    await selectMermaidMode("Source", "source");
    const backToSource = await evaluate<{ iframeCount: number; sourceHidden: boolean }>(`(() => {
      const host = document.querySelector('main [data-artifact-markdown] [data-mermaid-view="source"]');
      const source = host?.querySelector(".artifact-markdown-code-source");
      return {
        iframeCount: host?.querySelectorAll("iframe.mermaid-diagram-frame").length ?? -1,
        sourceHidden: Boolean(source?.classList.contains("code-block-source-visually-hidden")),
      };
    })()`);
    expect(backToSource.iframeCount).toBe(0);
    expect(backToSource.sourceHidden).toBe(false);

    await selectMermaidMode("Diagram", "diagram");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main [data-artifact-markdown] [data-mermaid-view="diagram"] iframe.mermaid-diagram-frame') != null`,
    );

    const initialHtml = await evaluate<{
      hasPreviewView: boolean;
      srcdoc: string;
      sourceHidden: boolean;
    }>(`(() => {
      const host = document.querySelector('main [data-artifact-markdown] [data-html-view="preview"]');
      const iframe = host?.querySelector('iframe[aria-label="HTML preview"][sandbox="allow-scripts"]');
      const source = host?.querySelector(".artifact-markdown-code-source");
      return {
        hasPreviewView: Boolean(host),
        srcdoc: iframe?.getAttribute("srcdoc") ?? "",
        sourceHidden: Boolean(source?.classList.contains("code-block-source-visually-hidden")),
      };
    })()`);
    expect(initialHtml.hasPreviewView).toBe(true);
    expect(initialHtml.srcdoc).toContain("Sandboxed card widget");
    expect(initialHtml.sourceHidden).toBe(true);

    await evaluate(
      `(document.querySelector('main [data-artifact-markdown] [data-testid="code-block-html-view"]')?.scrollIntoView({ block: "center" }), true)`,
    );
    await browser("click", 'main [data-artifact-markdown] [data-testid="code-block-html-view"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main [data-artifact-markdown] [data-html-view="source"]') != null`,
    );
    const htmlSourceView = await evaluate<{
      iframeCount: number;
      sourceHidden: boolean;
      sourceText: string;
    }>(`(() => {
      const host = document.querySelector('main [data-artifact-markdown] [data-html-view="source"]');
      const source = host?.querySelector(".artifact-markdown-code-source");
      return {
        iframeCount: host?.querySelectorAll('iframe[aria-label="HTML preview"]').length ?? -1,
        sourceHidden: Boolean(source?.classList.contains("code-block-source-visually-hidden")),
        sourceText: source?.textContent ?? "",
      };
    })()`);
    expect(htmlSourceView.iframeCount).toBe(0);
    expect(htmlSourceView.sourceHidden).toBe(false);
    expect(htmlSourceView.sourceText).toContain(
      '<div id="preview-card">Sandboxed card widget</div>',
    );

    await browser("click", 'main [data-artifact-markdown] [data-testid="code-block-html-view"]');
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main [data-artifact-markdown] [data-html-view="preview"] iframe[aria-label="HTML preview"]') != null`,
    );

    await clickElement("main [data-artifact-markdown] p");
    await evaluate(`(window.getSelection()?.removeAllRanges(), document.body.focus(), true)`);
    await browser("press", `${modKey}+a`);
    await browser("wait", "--fn", `(window.getSelection()?.toString() ?? "").includes("Release")`);
    const selectAllCopy = await readCopiedViaRealPaste(cdp);
    expect(selectAllCopy.plain).toContain(`Goal ${tail}`);
    expect(selectAllCopy.plain).toContain("$E = mc^2$");
    expect(selectAllCopy.plain).toContain("$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$");
    expect(selectAllCopy.plain).toContain("[x] Done task item");
    expect(selectAllCopy.plain).toContain("Release\tDev");
    expect(selectAllCopy.plain).toContain("A[Read] --> B[Copy]");
    expect(selectAllCopy.plain).toContain('<div id="preview-card">Sandboxed card widget</div>');
    expect(selectAllCopy.plain).not.toContain("Outline");
    expect(selectAllCopy.plain).not.toContain("Launch plan");
    expect(selectAllCopy.plain).not.toContain("Copy code");
    expect(selectAllCopy.plain).not.toContain("Diagram view");
    expect(selectAllCopy.plain).not.toContain("Show source");
    expect(selectAllCopy.plain).not.toContain("Show preview");
    expect(selectAllCopy.plain).not.toContain("HTML preview");
    expect(selectAllCopy.plain).not.toContain("tsconst");
    expect(selectAllCopy.plain).not.toContain("ItemOwner");
    expect(selectAllCopy.html).not.toContain("<iframe");
    expect(selectAllCopy.html).not.toContain("data-anchor-chrome");

    await dragPoints(
      "main [data-artifact-markdown] li.task-list-item",
      "main [data-artifact-markdown] li.task-list-item ~ li.task-list-item",
    );
    const partialTaskCopy = await readCopiedViaRealPaste(cdp);
    expect(partialTaskCopy.html).toContain('data-type="taskList"');
    expect(partialTaskCopy.html).toContain('data-type="taskItem"');
    expect(partialTaskCopy.plain).toContain("[x] Done task item\n[ ] Open follow-up item");

    await browser("press", `${modKey}+f`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector("[data-artifact-find-bar] input") != null`,
    );
    await browser("fill", "[data-artifact-find-bar] input", "Friday");
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: cdpMod,
      commands: ["selectAll"],
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: cdpMod,
    });
    expect(
      await evaluate<boolean>(`(() => {
        const input = document.querySelector("[data-artifact-find-bar] input");
        return Boolean(
          input &&
            document.activeElement === input &&
            input.selectionStart === 0 &&
            input.selectionEnd === input.value.length &&
            !window.getSelection()?.toString().includes("Prepare release notes")
        );
      })()`),
    ).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector("[data-artifact-find-bar]") == null`);
  } finally {
    cdp.close();
  }

  return doc.id;
}
