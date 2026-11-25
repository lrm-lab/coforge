import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";

export type ArtifactPointerArea = "none" | "inside" | "outside";

const EDITABLE_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="textbox"]';
const INTERCEPT_COPY_SELECTOR =
  "[data-anchor-chrome], .katex-mathml, .artifact-markdown-code, .artifact-markdown-table, ul.contains-task-list, li.task-list-item";

function closestFormulaHost(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return null;
  return (
    element.closest(".message-markdown-formula") ??
    element.closest(".message-markdown-formula-inline") ??
    element.closest(".katex-display") ??
    element.closest(".katex")
  );
}

export function isEditableElementActive(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest(EDITABLE_TARGET_SELECTOR));
}

export function shouldInterceptArtifactCopy(range: Range): boolean {
  const fragment = range.cloneContents();
  return Boolean(
    fragment.querySelector(INTERCEPT_COPY_SELECTOR) ||
    closestFormulaHost(range.startContainer) ||
    closestFormulaHost(range.endContainer),
  );
}

function unwrapElements(root: ParentNode, selector: string): void {
  for (const wrapper of root.querySelectorAll(selector)) {
    const parent = wrapper.parentNode;
    if (!parent) continue;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
}

function normalizeTaskLists(root: ParentNode): void {
  for (const list of root.querySelectorAll("ul.contains-task-list")) {
    list.setAttribute("data-type", "taskList");
  }
  for (const item of root.querySelectorAll("li.task-list-item")) {
    const checkbox = [...item.querySelectorAll('input[type="checkbox"]')].find(
      (input) => input.closest("li.task-list-item") === item,
    ) as HTMLInputElement | undefined;
    if (!checkbox) continue;
    const checked = checkbox.checked || checkbox.hasAttribute("checked");
    const nextSibling = checkbox.nextSibling;
    checkbox.remove();
    if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent) {
      nextSibling.textContent = nextSibling.textContent.replace(/^[ \t]+/, "");
    }
    item.setAttribute("data-type", "taskItem");
    item.setAttribute("data-checked", checked ? "true" : "false");
  }
}

function normalizeFormulas(root: ParentNode): void {
  for (const formula of root.querySelectorAll(".katex-mathml")) {
    const tex = formula.querySelector("annotation")?.textContent?.trim();
    const outer = closestFormulaHost(formula) ?? formula;
    if (!outer.parentNode) continue;
    if (!tex) {
      outer.remove();
      continue;
    }
    const display =
      outer.classList.contains("message-markdown-formula") ||
      outer.classList.contains("katex-display") ||
      Boolean(outer.querySelector(".katex-display"));
    const replacement = document.createElement(display ? "div" : "span");
    replacement.setAttribute("data-type", display ? "block-math" : "inline-math");
    replacement.setAttribute("data-expression", tex);
    replacement.textContent = tex;
    outer.replaceWith(replacement);
  }
}

function wrapDirectNodeRuns(
  root: Element,
  matches: (node: Node) => node is Element,
  createWrapper: (run: Element[]) => Element,
): void {
  let cursor = root.firstChild;
  while (cursor) {
    if (!matches(cursor)) {
      cursor = cursor.nextSibling;
      continue;
    }
    const run: Element[] = [cursor];
    const whitespaceBetween: ChildNode[] = [];
    let pendingWhitespace: ChildNode[] = [];
    let scan: ChildNode | null = cursor.nextSibling;
    while (scan) {
      if (matches(scan)) {
        run.push(scan);
        whitespaceBetween.push(...pendingWhitespace);
        pendingWhitespace = [];
        scan = scan.nextSibling;
        continue;
      }
      if (scan.nodeType === Node.TEXT_NODE && !(scan.textContent ?? "").trim()) {
        pendingWhitespace.push(scan);
        scan = scan.nextSibling;
        continue;
      }
      break;
    }
    const after = run[run.length - 1]!.nextSibling;
    const wrapper = createWrapper(run);
    root.insertBefore(wrapper, cursor);
    for (const item of run) wrapper.appendChild(item);
    for (const ws of whitespaceBetween) ws.remove();
    cursor = after;
  }
}

function wrapDirectListItems(root: Element, ancestor: Node): void {
  const sourceListTag = (ancestor instanceof Element ? ancestor : ancestor.parentElement)?.closest(
    "ol, ul",
  )?.tagName;
  wrapDirectNodeRuns(
    root,
    (node): node is Element => node instanceof Element && node.tagName === "LI",
    (run) => {
      const hasTaskItem = run.some((item) => item.getAttribute("data-type") === "taskItem");
      const list = document.createElement(hasTaskItem || sourceListTag !== "OL" ? "ul" : "ol");
      if (hasTaskItem) list.setAttribute("data-type", "taskList");
      return list;
    },
  );
}

function wrapDirectTableCells(root: Element): void {
  wrapDirectNodeRuns(
    root,
    (node): node is Element =>
      node instanceof Element && (node.tagName === "TD" || node.tagName === "TH"),
    () => document.createElement("tr"),
  );
}

function normalizeInlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.classList.contains("katex-html")) return "";
  const dataType = node.getAttribute("data-type");
  if (dataType === "inline-math") {
    return `$${node.getAttribute("data-expression") ?? node.textContent ?? ""}$`;
  }
  if (dataType === "block-math") {
    return `$$${node.getAttribute("data-expression") ?? node.textContent ?? ""}$$`;
  }
  let out = "";
  for (const child of node.childNodes) out += normalizeInlineText(child);
  return out;
}

function pushBlock(blocks: string[], value: string): void {
  const trimmed = value.replace(/^\n+|\n+$/g, "");
  if (trimmed !== "") blocks.push(trimmed);
}

function serializeRowCells(tr: Element): string | null {
  const cells = [...tr.children]
    .filter((child) => child.tagName === "TH" || child.tagName === "TD")
    .map((cell) => normalizeInlineText(cell).replace(/\s+/g, " ").trim());
  return cells.length > 0 ? cells.join("\t") : null;
}

function serializeTableRows(container: Element, directChildrenOnly: boolean): string {
  const rows: string[] = [];
  for (const tr of container.querySelectorAll("tr")) {
    if (directChildrenOnly ? tr.parentElement !== container : tr.closest("table") !== container) {
      continue;
    }
    const line = serializeRowCells(tr);
    if (line) rows.push(line);
  }
  return rows.join("\n");
}

function serializeList(list: Element, depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const child of list.children) {
    if (child.tagName !== "LI") continue;
    const nestedLists: Element[] = [];
    const inlineParts: string[] = [];
    for (const part of child.childNodes) {
      if (part instanceof Element && (part.tagName === "UL" || part.tagName === "OL")) {
        nestedLists.push(part);
      } else if (part instanceof Element && part.tagName === "P") {
        const text = normalizeInlineText(part).trim();
        if (text) inlineParts.push(text);
      } else {
        inlineParts.push(normalizeInlineText(part));
      }
    }
    const text = inlineParts
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    const isTask = child.getAttribute("data-type") === "taskItem";
    const prefix = isTask ? (child.getAttribute("data-checked") === "true" ? "[x] " : "[ ] ") : "";
    if (text || isTask) lines.push(`${indent}${prefix}${text}`.trimEnd());
    for (const nested of nestedLists) {
      const sub = serializeList(nested, depth + 1);
      if (sub) lines.push(sub);
    }
  }
  return lines.join("\n");
}

function collectBlocks(node: Node, blocks: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/[ \t\n]+/g, " ").trim();
    if (text) pushBlock(blocks, text);
    return;
  }
  if (!(node instanceof Element)) return;
  const dataType = node.getAttribute("data-type");
  if (dataType === "block-math") {
    pushBlock(blocks, `$$${node.getAttribute("data-expression") ?? node.textContent ?? ""}$$`);
    return;
  }
  if (dataType === "inline-math") {
    pushBlock(blocks, `$${node.getAttribute("data-expression") ?? node.textContent ?? ""}$`);
    return;
  }
  const tag = node.tagName;
  if (tag === "PRE") {
    const codeText = (node.textContent ?? "").replace(/\n$/, "");
    if (codeText !== "") blocks.push(codeText);
    return;
  }
  if (tag === "HR") {
    blocks.push("---");
    return;
  }
  if (tag === "TABLE") {
    pushBlock(blocks, serializeTableRows(node, false));
    return;
  }
  if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") {
    pushBlock(blocks, serializeTableRows(node, true));
    return;
  }
  if (tag === "TR") {
    const line = serializeRowCells(node);
    if (line) blocks.push(line);
    return;
  }
  if (tag === "UL" || tag === "OL") {
    pushBlock(blocks, serializeList(node));
    return;
  }
  if (
    tag === "H1" ||
    tag === "H2" ||
    tag === "H3" ||
    tag === "H4" ||
    tag === "H5" ||
    tag === "H6" ||
    tag === "P"
  ) {
    pushBlock(
      blocks,
      normalizeInlineText(node)
        .replace(/[ \t]+/g, " ")
        .trim(),
    );
    return;
  }
  const childBlocks: string[] = [];
  let inlineBuffer = "";
  const flushInline = () => {
    const clean = inlineBuffer.replace(/[ \t]+/g, " ").trim();
    inlineBuffer = "";
    if (clean) childBlocks.push(clean);
  };
  for (const child of node.childNodes) {
    if (
      child instanceof Element &&
      [
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "P",
        "PRE",
        "UL",
        "OL",
        "TABLE",
        "THEAD",
        "TBODY",
        "TFOOT",
        "TR",
        "BLOCKQUOTE",
        "HR",
        "DIV",
        "SECTION",
        "ARTICLE",
      ].includes(child.tagName)
    ) {
      if (child.getAttribute("data-type") === "inline-math") {
        inlineBuffer += normalizeInlineText(child);
      } else {
        flushInline();
        collectBlocks(child, childBlocks);
      }
    } else {
      inlineBuffer += normalizeInlineText(child);
    }
  }
  flushInline();
  for (const block of childBlocks) blocks.push(block);
}

function serializePlainText(root: Element): string {
  const blocks: string[] = [];
  collectBlocks(root, blocks);
  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function expandTaskItemStart(range: Range): void {
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const taskItem = startElement?.closest("li.task-list-item");
  if (!taskItem || taskItem.contains(range.endContainer)) return;
  const probe = document.createRange();
  probe.setStart(taskItem, 0);
  probe.setEnd(range.startContainer, range.startOffset);
  if (probe.toString().trim() === "") {
    range.setStartBefore(taskItem);
  }
}

export function buildArtifactCopyPayload(range: Range): { html: string; plain: string } | null {
  const expanded = range.cloneRange();
  const startFormula = closestFormulaHost(expanded.startContainer);
  if (startFormula) expanded.setStartBefore(startFormula);
  const endFormula = closestFormulaHost(expanded.endContainer);
  if (endFormula) expanded.setEndAfter(endFormula);
  expandTaskItemStart(expanded);

  const htmlRoot = document.createElement("div");
  htmlRoot.appendChild(expanded.cloneContents());
  for (const chrome of htmlRoot.querySelectorAll("[data-anchor-chrome]")) chrome.remove();
  for (const source of htmlRoot.querySelectorAll(".artifact-markdown-code-source")) {
    source.classList.remove(
      "code-block-source-visually-hidden",
      "sr-only",
      "border-t",
      "border-secondary",
    );
    source.removeAttribute("aria-hidden");
  }
  unwrapElements(htmlRoot, ".artifact-markdown-table, .artifact-markdown-code");
  normalizeTaskLists(htmlRoot);
  normalizeFormulas(htmlRoot);
  wrapDirectListItems(htmlRoot, expanded.commonAncestorContainer);
  wrapDirectTableCells(htmlRoot);

  const html = htmlRoot.innerHTML;
  const plain = serializePlainText(htmlRoot);
  if (!html.trim() && !plain) return null;
  return { html, plain };
}

export function isArtifactMarkdownBodyTarget(
  target: EventTarget | null,
  article: HTMLElement,
): boolean {
  return target instanceof Node && article.contains(target);
}

export function shouldSelectAllArtifactMarkdown(
  event: KeyboardEvent,
  article: HTMLElement,
  lastPointerArea: ArtifactPointerArea,
): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a") return false;
  if (article.closest("[inert]")) return false;

  if (isEditableElementActive()) return false;
  const active = document.activeElement;

  for (const overlay of document.querySelectorAll(OPEN_OVERLAY_SELECTOR)) {
    if (!overlay.contains(article)) return false;
  }

  if (active instanceof Node && article.contains(active)) {
    return true;
  }

  const isContainerFocus =
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    (active instanceof Node && active.contains(article));

  if (!isContainerFocus) {
    return false;
  }

  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    return article.contains(selection.getRangeAt(0).commonAncestorContainer);
  }

  if (lastPointerArea === "outside") return false;

  const preview = article.closest("[data-artifact-preview]");
  if (preview && !preview.matches(":modal")) {
    return lastPointerArea === "inside";
  }

  return true;
}
