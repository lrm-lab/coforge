import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowUpRight,
  Check,
  Copy01,
  Download01,
  Expand01,
  Minimize01,
  ParagraphWrap,
  SearchLg,
} from "@untitledui/icons";
import { useKeyboard } from "react-aria";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { styles as buttonStyles } from "#src/components/base/buttons/button";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { ContentEditor } from "#src/features/records/report-editor/content-editor";
import { copyText } from "#src/lib/clipboard";
import { sharedLowlight } from "#src/features/records/report-editor/lowlight";
import { formatFileSize, getFileExtension } from "#src/features/files/file-meta";
import { extensionToLanguage } from "#src/features/files/preview";
import "#src/features/records/report-editor/styles/code.css";
import { readShortcutBindings } from "#src/features/shortcuts/shortcut-bindings";
import { hotkeyMatchesEvent } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { splitHighlightedLines, type HastRoot } from "./split-highlighted-lines";
import { useFindInFile } from "./use-find-in-file";
import { ZEN_LAYER } from "./zen-layer";
import { FindBar, ToolbarToggle } from "./project-file-toolbar";
import "./project-file-view.css";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

const CHUNK_SIZE = 200;
const LINE_HEIGHT_REM = 1.25;
const MAX_HIGHLIGHT_CHARS = 512_000;
const WRAP_STORAGE_KEY = "coforge-file-wrap";

export function ProjectFileView({
  path,
  name,
  byteSize,
  text,
  githubUrl,
  downloadUrl,
  barLeading,
}: {
  path: string;
  name: string;
  byteSize?: number;
  text: string | null;
  githubUrl?: string;
  downloadUrl?: string;
  barLeading?: ReactNode;
}) {
  const isMarkdown = MARKDOWN_EXTENSIONS.has(getFileExtension(name));
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readWrapPreference);
  const [zen, setZen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const codeRootRef = useRef<HTMLDivElement>(null);
  const zenButtonRef = useRef<HTMLButtonElement>(null);

  const lines = useMemo(() => computeLines(text, name), [text, name]);
  const showCode = text !== null && (!isMarkdown || tab === "source");

  const find = useFindInFile({ text, codeRootRef, enabled: showCode });

  useEffect(() => () => clearTimeout(copyTimeoutRef.current), []);

  const dir =
    path.length > name.length && path.endsWith(name)
      ? path.slice(0, path.length - name.length)
      : "";
  const sizeLabel = byteSize !== undefined ? formatFileSize(byteSize) : undefined;
  const metaParts = [
    text !== null ? m.project_file_lines({ count: lines.length }) : null,
    sizeLabel,
  ].filter((part): part is string => Boolean(part));

  async function handleCopy() {
    if (text === null) return;
    if (!(await copyText(text))) return;
    setCopied(true);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  function openFind() {
    if (isMarkdown && tab === "preview") setTab("source");
    find.open();
  }

  function handleTabChange(next: "preview" | "source") {
    setTab(next);
    if (next === "preview" && find.findOpen) find.close();
  }

  const setZenMode = useCallback((next: boolean) => {
    setZen(next);
    if (next) scrollerRef.current?.focus();
    else zenButtonRef.current?.focus();
  }, []);

  const { keyboardProps } = useKeyboard({
    onKeyDown(event) {
      const apple = isApplePlatform();
      const isFindShortcut = readShortcutBindings("previewFind").some((hotkey) =>
        hotkeyMatchesEvent(hotkey, event, apple),
      );
      if (isFindShortcut) {
        if (!find.findSupported) {
          event.continuePropagation();
          return;
        }
        const findBarHasFocus =
          find.findOpen &&
          Boolean(
            rootRef.current?.querySelector("[data-find-bar]")?.contains(document.activeElement),
          );
        if (findBarHasFocus) {
          event.continuePropagation();
          return;
        }
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === "Escape" && find.findOpen) {
        find.close();
        return;
      }
      if (event.key === "Escape" && zen) {
        setZenMode(false);
        return;
      }
      event.continuePropagation();
    },
  });

  const findRef = useRef(find);
  findRef.current = find;
  useEffect(() => {
    if (!zen) return;
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (findRef.current.findOpen) {
        findRef.current.close();
        return;
      }
      setZenMode(false);
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [zen, setZenMode]);

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) find.previous();
      else find.next();
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn("flex min-h-0 flex-1 flex-col", zen && ZEN_LAYER)}
      {...keyboardProps}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b border-secondary py-2",
          barLeading ? "px-3" : "px-4",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {barLeading}
          <span className="flex min-w-0 items-baseline">
            <span className="min-w-0 truncate text-sm text-tertiary">{dir}</span>
            <span className="shrink-0 text-sm font-medium text-primary">{name}</span>
          </span>
          {metaParts.length > 0 && !barLeading && (
            <span className="inline-flex shrink-0 items-center gap-2 text-xs text-tertiary tabular-nums">
              {metaParts.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isMarkdown && text !== null && (
            <ButtonGroup
              aria-label={m.project_file_preview()}
              size="sm"
              selectedKeys={[tab]}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next === "preview" || next === "source") handleTabChange(next);
              }}
              className="mr-1"
            >
              <ButtonGroupItem id="preview">{m.project_file_preview()}</ButtonGroupItem>
              <ButtonGroupItem id="source">{m.project_file_source()}</ButtonGroupItem>
            </ButtonGroup>
          )}
          <TooltipGroup className="flex items-center gap-0.5">
            {showCode && find.findSupported && (
              <Tooltip title={m.project_file_find()}>
                <Button
                  size="sm"
                  color="tertiary"
                  aria-label={m.project_file_find()}
                  iconLeading={SearchLg}
                  onPress={() => (find.findOpen ? find.close() : openFind())}
                />
              </Tooltip>
            )}
            {showCode && (
              <Tooltip title={m.project_file_wrap()}>
                <ToolbarToggle
                  aria-label={m.project_file_wrap()}
                  isSelected={wrap}
                  onChange={(next) => {
                    setWrap(next);
                    writeWrapPreference(next);
                  }}
                >
                  <ParagraphWrap data-icon="leading" className={buttonStyles.common.icon} />
                </ToolbarToggle>
              </Tooltip>
            )}
            <Tooltip title={zen ? m.project_file_zen_exit() : m.project_file_zen()}>
              <ToolbarToggle
                ref={zenButtonRef}
                aria-label={zen ? m.project_file_zen_exit() : m.project_file_zen()}
                isSelected={zen}
                onChange={setZenMode}
              >
                {zen ? (
                  <Minimize01 data-icon="leading" className={buttonStyles.common.icon} />
                ) : (
                  <Expand01 data-icon="leading" className={buttonStyles.common.icon} />
                )}
              </ToolbarToggle>
            </Tooltip>
            {text !== null && (
              <Tooltip title={copied ? m.project_file_copied() : m.project_file_copy()}>
                <Button
                  size="sm"
                  color="tertiary"
                  aria-label={copied ? m.project_file_copied() : m.project_file_copy()}
                  iconLeading={copied ? Check : Copy01}
                  onPress={handleCopy}
                />
              </Tooltip>
            )}
            {downloadUrl !== undefined && (
              <Tooltip title={m.project_file_download()}>
                <Button
                  size="sm"
                  color="tertiary"
                  aria-label={m.project_file_download()}
                  iconLeading={Download01}
                  href={downloadUrl}
                  download={name}
                />
              </Tooltip>
            )}
            {githubUrl !== undefined && (
              <Tooltip title={m.project_open_on_github()}>
                <Button
                  size="sm"
                  color="tertiary"
                  aria-label={m.project_open_on_github()}
                  iconLeading={ArrowUpRight}
                  href={githubUrl}
                  target="_blank"
                  rel="noreferrer"
                />
              </Tooltip>
            )}
          </TooltipGroup>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollerRef}
          tabIndex={0}
          role="region"
          aria-label={name}
          className="min-h-0 flex-1 overflow-auto bg-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {text === null ? (
            <NotPreviewable githubUrl={githubUrl} downloadUrl={downloadUrl} name={name} />
          ) : isMarkdown && tab === "preview" ? (
            <div className="mx-auto max-w-3xl px-6 py-4">
              <ContentEditor editable={false} defaultValue={text} />
            </div>
          ) : (
            <CodeView lines={lines} wrap={wrap} codeRootRef={codeRootRef} />
          )}
        </div>
        {showCode && find.findOpen && (
          <FindBar
            inputRef={find.inputRef}
            query={find.query}
            onQueryChange={find.setQuery}
            caseSensitive={find.caseSensitive}
            onCaseSensitiveChange={find.setCaseSensitive}
            matchCount={find.matches.length}
            activeMatchIndex={find.activeMatchIndex}
            onNext={find.next}
            onPrevious={find.previous}
            onClose={find.close}
            onKeyDown={handleFindKeyDown}
          />
        )}
      </div>
    </div>
  );
}

function NotPreviewable({
  githubUrl,
  downloadUrl,
  name,
}: {
  githubUrl?: string;
  downloadUrl?: string;
  name: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <p className="text-sm text-tertiary">{m.project_file_not_previewable()}</p>
      <div className="flex items-center gap-2">
        {githubUrl !== undefined && (
          <Button
            size="sm"
            color="secondary"
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            iconTrailing={ArrowUpRight}
          >
            {m.project_open_on_github()}
          </Button>
        )}
        {downloadUrl !== undefined && (
          <Button
            size="sm"
            color="secondary"
            href={downloadUrl}
            download={name}
            iconLeading={Download01}
          >
            {m.project_file_download()}
          </Button>
        )}
      </div>
    </div>
  );
}

function CodeView({
  lines,
  wrap,
  codeRootRef,
}: {
  lines: string[];
  wrap: boolean;
  codeRootRef: RefObject<HTMLDivElement | null>;
}) {
  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) result.push(lines.slice(i, i + CHUNK_SIZE));
    return result;
  }, [lines]);
  const gutterWidth = `${String(lines.length).length}ch`;

  return (
    <div
      ref={codeRootRef}
      className="pfv-code-root rich-text-editor relative min-h-full min-w-full py-2 font-mono text-xs tab-4"
      data-wrap={wrap ? "on" : "off"}
      style={{ "--pfv-gutter-w": gutterWidth } as CSSProperties}
    >
      {chunks.map((chunkLines, chunkIndex) => (
        <div
          key={chunkIndex}
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: `auto ${chunkLines.length * LINE_HEIGHT_REM}rem`,
          }}
          dangerouslySetInnerHTML={{
            __html: renderChunkHtml(chunkLines, chunkIndex * CHUNK_SIZE),
          }}
        />
      ))}
    </div>
  );
}

function renderChunkHtml(chunkLines: string[], startIndex: number): string {
  let html = "";
  for (let i = 0; i < chunkLines.length; i++) {
    const lineNumber = startIndex + i + 1;
    html +=
      `<div class="pfv-row flex w-max min-w-full gap-4">` +
      `<span class="pfv-lineno sticky left-0 z-10 shrink-0 select-none border-r border-secondary bg-primary pr-3 text-right text-quaternary" data-line="${lineNumber}"></span>` +
      `<span class="pfv-code">${chunkLines[i]}</span>` +
      `</div>`;
  }
  return html;
}

function computeLines(text: string | null, name: string): string[] {
  if (text === null) return [];
  const language = MARKDOWN_EXTENSIONS.has(getFileExtension(name))
    ? "markdown"
    : extensionToLanguage(name);
  return splitHighlightedLines(highlight(text, language));
}

function highlight(text: string, language: string | undefined): HastRoot {
  const canHighlight =
    Boolean(language) && sharedLowlight.registered(language!) && text.length <= MAX_HIGHLIGHT_CHARS;
  if (canHighlight) {
    try {
      return sharedLowlight.highlight(language!, text);
    } catch {
      return { type: "root", children: [{ type: "text", value: text }] };
    }
  }
  return { type: "root", children: [{ type: "text", value: text }] };
}

function readWrapPreference(): boolean {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeWrapPreference(wrap: boolean) {
  try {
    localStorage.setItem(WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch {
    return;
  }
}
