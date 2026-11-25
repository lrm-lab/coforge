import {
  Suspense,
  lazy,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { useRouter } from "@tanstack/react-router";
import { Check, Code01, Columns02, Copy01, Download01, Eye, ZoomIn } from "@untitledui/icons";
import type { Element } from "hast";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import {
  followInternalLinkClick,
  internalAppHref,
} from "#src/features/conversations/internal-app-href";
import { MessageFormula } from "#src/features/conversations/message-formula";
import { CodeBlockIframe } from "#src/features/records/report-editor/code-block-iframe";
import {
  parseCodeFenceInfo,
  type MermaidViewMode,
} from "#src/features/records/report-editor/extensions/code-block-fence";
import { useT } from "#src/features/records/report-editor/i18n";
import type { MermaidDiagramHandle } from "#src/features/records/report-editor/mermaid-diagram";
import {
  resolveMermaidViewMode,
  writeMermaidViewPreference,
} from "#src/features/records/report-editor/mermaid-view-preference";
import { ReportImageZoom } from "#src/features/records/report-image-zoom";
import { copyText } from "#src/lib/clipboard";
import { remarkMessageMath, rewriteLatexDelimiters } from "#src/lib/message-math";
import { cn } from "#src/lib/utils";
import { highlightCodeByLanguage } from "./artifact-code-highlight";
import {
  buildArtifactCopyPayload,
  isArtifactMarkdownBodyTarget,
  isEditableElementActive,
  shouldInterceptArtifactCopy,
  shouldSelectAllArtifactMarkdown,
  type ArtifactPointerArea,
} from "./artifact-markdown-copy";

const MermaidDiagram = lazy(() =>
  import("#src/features/records/report-editor/mermaid-diagram").then((mod) => ({
    default: mod.MermaidDiagram,
  })),
);

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkMessageMath];
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [rehypeSanitize];

function textOfHast(node: Element | undefined): string {
  if (!node) return "";
  return node.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "element") return textOfHast(child);
      return "";
    })
    .join("");
}

function CopyIconButton({
  text,
  label,
  copiedLabel,
  onCopiedChange,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  onCopiedChange?: (copied: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyCount, setCopyCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <>
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={copied ? Check : Copy01}
        tooltip={copied ? copiedLabel : label}
        aria-label={copied ? copiedLabel : label}
        onClick={async () => {
          if (!text) return;
          clearTimeout(timerRef.current);
          if (await copyText(text)) {
            setCopied(true);
            setCopyCount((count) => count + 1);
            onCopiedChange?.(true);
            timerRef.current = setTimeout(() => {
              setCopied(false);
              onCopiedChange?.(false);
            }, 2000);
          }
        }}
      />
      <span className="sr-only" role="status">
        {copied ? (copyCount % 2 === 0 ? `${copiedLabel}\u00A0` : copiedLabel) : ""}
      </span>
    </>
  );
}

function HighlightedCode({ language, code }: { language: string; code: string }) {
  const highlighted = useMemo(() => highlightCodeByLanguage(code, language), [code, language]);
  const displayLanguage = language && language !== "plaintext" ? language : "";

  return (
    <code className={displayLanguage ? `language-${displayLanguage}` : undefined}>
      {highlighted
        ? highlighted.map((tokens, lineIndex) => (
            <span key={lineIndex}>
              {tokens.map((token, tokenIndex) =>
                token.className ? (
                  <span key={tokenIndex} className={token.className}>
                    {token.text}
                  </span>
                ) : (
                  token.text
                ),
              )}
              {lineIndex < highlighted.length - 1 ? "\n" : null}
            </span>
          ))
        : code}
    </code>
  );
}

function ArtifactCodeBlock({ language, code }: { language: string; code: string }) {
  const { t } = useT("editor");
  const [copied, setCopied] = useState(false);
  const trimmedCode = code.replace(/\n$/, "");
  const displayLanguage = language && language !== "plaintext" ? language : "";

  return (
    <div className="artifact-markdown-code group/code relative my-3">
      <div
        data-anchor-chrome=""
        data-copied={copied ? "" : undefined}
        className="artifact-markdown-code-chrome flex items-center gap-1 select-none"
      >
        {displayLanguage && (
          <span className="artifact-markdown-code-lang px-1.5 font-mono text-xs text-tertiary lowercase">
            {displayLanguage}
          </span>
        )}
        <CopyIconButton
          text={trimmedCode}
          label={t(($) => $.code_block.copy_code)}
          copiedLabel={t(($) => $.code_block.copied)}
          onCopiedChange={setCopied}
        />
      </div>
      <pre
        tabIndex={0}
        className="focus:outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <HighlightedCode language={language} code={trimmedCode} />
      </pre>
    </div>
  );
}

function ArtifactHtmlBlock({ code }: { code: string }) {
  const { t } = useT("editor");
  const trimmedCode = code.replace(/\n$/, "");
  const hasHtml = Boolean(trimmedCode.trim());
  const [view, setView] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const showPreview = view === "preview" && hasHtml;
  const showSource = !showPreview;

  return (
    <div
      data-html-view={showPreview ? "preview" : "source"}
      className="artifact-markdown-code group/code relative my-3"
    >
      <div
        data-anchor-chrome=""
        data-copied={copied ? "" : undefined}
        className="artifact-markdown-code-chrome flex items-center gap-0.5 select-none"
      >
        <span className="artifact-markdown-code-lang px-1.5 font-mono text-xs text-tertiary">
          html
        </span>
        {hasHtml && (
          <ButtonUtility
            data-testid="code-block-html-view"
            size="xs"
            color="tertiary"
            icon={showPreview ? Code01 : Eye}
            tooltip={
              showPreview ? t(($) => $.code_block.show_source) : t(($) => $.code_block.show_preview)
            }
            aria-label={
              showPreview ? t(($) => $.code_block.show_source) : t(($) => $.code_block.show_preview)
            }
            onClick={() => setView((prev) => (prev === "preview" ? "source" : "preview"))}
          />
        )}
        <CopyIconButton
          text={trimmedCode}
          label={t(($) => $.code_block.copy_code)}
          copiedLabel={t(($) => $.code_block.copied)}
          onCopiedChange={setCopied}
        />
      </div>
      {showPreview && (
        <div data-anchor-chrome="" className="p-3">
          <CodeBlockIframe html={trimmedCode} title="HTML preview" heightClassName="h-[30rem]" />
        </div>
      )}
      <pre
        tabIndex={showSource ? 0 : undefined}
        aria-hidden={!showSource ? "true" : undefined}
        className={cn(
          "artifact-markdown-code-source",
          showSource
            ? "focus:outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
            : "code-block-source-visually-hidden",
        )}
      >
        <HighlightedCode language="html" code={trimmedCode} />
      </pre>
    </div>
  );
}

function ArtifactMermaidBlock({
  chart,
  initialView,
}: {
  chart: string;
  initialView: MermaidViewMode;
}) {
  const { t } = useT("editor");
  const mermaidRef = useRef<MermaidDiagramHandle>(null);
  const trimmedChart = chart.replace(/\n$/, "");
  const hasChart = Boolean(trimmedChart.trim());
  const [view, setView] = useState<MermaidViewMode>(initialView);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setView(
      resolveMermaidViewMode({
        attrView: null,
        fenceView: initialView,
        chart: trimmedChart,
      }),
    );
  }, [trimmedChart, initialView]);

  const handleViewChange = (mode: MermaidViewMode) => {
    writeMermaidViewPreference(trimmedChart, mode);
    setView(mode);
  };

  const showDiagram = view !== "source" && hasChart;
  const showSource = view !== "diagram" || !hasChart;

  return (
    <div data-mermaid-view={view} className="artifact-markdown-code group/code relative my-3">
      <div
        data-anchor-chrome=""
        data-copied={copied ? "" : undefined}
        data-menu-open={menuOpen ? "" : undefined}
        className="artifact-markdown-code-chrome flex items-center gap-0.5 select-none"
      >
        <span className="artifact-markdown-code-lang px-1.5 font-mono text-xs text-tertiary">
          mermaid
        </span>
        <Dropdown.Root onOpenChange={setMenuOpen}>
          <ButtonUtility
            data-testid="code-block-mermaid-view"
            size="xs"
            color="tertiary"
            icon={Columns02}
            tooltip={t(($) => $.code_block.mermaid_view)}
            aria-label={t(($) => $.code_block.mermaid_view)}
          />
          <Dropdown.Popover placement="bottom end" offset={4} className="w-44">
            <Dropdown.Menu
              aria-label={t(($) => $.code_block.mermaid_view)}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[view]}
              onAction={(key) => {
                if (key === "source" || key === "diagram" || key === "both") {
                  handleViewChange(key);
                }
              }}
            >
              <Dropdown.Item id="source" label={t(($) => $.code_block.mermaid_source)} />
              <Dropdown.Item id="diagram" label={t(($) => $.code_block.mermaid_diagram)} />
              <Dropdown.Item id="both" label={t(($) => $.code_block.mermaid_both)} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        {showDiagram && (
          <>
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={ZoomIn}
              tooltip={t(($) => $.code_block.fullscreen)}
              aria-label={t(($) => $.code_block.fullscreen)}
              onClick={() => mermaidRef.current?.openFullscreen()}
            />
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Download01}
              tooltip={t(($) => $.code_block.download_diagram)}
              aria-label={t(($) => $.code_block.download_diagram)}
              onClick={() => mermaidRef.current?.downloadSvg()}
            />
          </>
        )}
        <CopyIconButton
          text={trimmedChart}
          label={t(($) => $.code_block.copy_code)}
          copiedLabel={t(($) => $.code_block.copied)}
          onCopiedChange={setCopied}
        />
      </div>
      {showDiagram && (
        <div data-anchor-chrome="" className="mermaid-diagram-preview p-3">
          <Suspense
            fallback={
              <div className="mermaid-diagram-loading">{t(($) => $.mermaid.rendering)}</div>
            }
          >
            <MermaidDiagram ref={mermaidRef} chart={chart} showToolbar={false} />
          </Suspense>
        </div>
      )}
      <pre
        tabIndex={showSource ? 0 : undefined}
        aria-hidden={!showSource ? "true" : undefined}
        className={cn(
          "artifact-markdown-code-source",
          showSource
            ? "focus:outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
            : "code-block-source-visually-hidden",
          showDiagram && showSource && "border-t border-secondary",
        )}
      >
        <code className="language-mermaid">{trimmedChart}</code>
      </pre>
    </div>
  );
}

function ArtifactLink({
  node,
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  void node;
  const router = useRouter();
  const internal = internalAppHref(typeof href === "string" ? href : undefined);
  if (internal) {
    const { target: _target, ...rest } = props;
    void _target;
    return (
      <a
        {...rest}
        href={internal}
        onClick={(event) => {
          if (!followInternalLinkClick(event)) return;
          event.preventDefault();
          void router.navigate({ href: internal });
        }}
      >
        {children}
      </a>
    );
  }
  if (typeof href === "string" && href.startsWith("#")) {
    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  }
  if (!href) {
    return <span>{children}</span>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function ArtifactInlineCode({
  node,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  if (className?.split(" ").includes("language-math")) {
    return <MessageFormula source={textOfHast(node)} display={false} />;
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function ArtifactPre({ node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const code = node?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  if (!code) return <pre {...props}>{children}</pre>;
  const className = code.properties?.className;
  const languageClass = Array.isArray(className)
    ? className.find(
        (item): item is string => typeof item === "string" && item.startsWith("language-"),
      )
    : undefined;
  const rawLang = languageClass?.slice("language-".length) ?? "";
  const rawMeta = (code.data as { meta?: unknown } | undefined)?.meta;
  const info = typeof rawMeta === "string" && rawMeta.trim() ? `${rawLang} ${rawMeta}` : rawLang;
  const fence = parseCodeFenceInfo(info);
  const source = textOfHast(code);

  if (fence.language === "math") return <MessageFormula source={source} display />;
  if (fence.language === "mermaid") {
    return <ArtifactMermaidBlock chart={source} initialView={fence.mermaidView} />;
  }
  if (fence.language.toLowerCase() === "html") {
    return <ArtifactHtmlBlock code={source} />;
  }
  return <ArtifactCodeBlock language={fence.language} code={source} />;
}

export const ArtifactMarkdownBody = memo(function ArtifactMarkdownBody({ text }: { text: string }) {
  const articleRef = useRef<HTMLElement>(null);
  const lastPointerAreaRef = useRef<ArtifactPointerArea>("none");
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const source = useMemo(() => rewriteLatexDelimiters(text), [text]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;

    const onPointerDown = (event: PointerEvent) => {
      lastPointerAreaRef.current = isArtifactMarkdownBodyTarget(event.target, article)
        ? "inside"
        : "outside";
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldSelectAllArtifactMarkdown(event, article, lastPointerAreaRef.current)) return;
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(article);
      selection.removeAllRanges();
      selection.addRange(range);
      article.focus({ preventScroll: true });
    };

    const onCopy = (event: globalThis.ClipboardEvent) => {
      if (isEditableElementActive()) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      if (!event.clipboardData) return;
      const range = selection.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) return;
      if (!shouldInterceptArtifactCopy(range)) return;
      const payload = buildArtifactCopyPayload(range);
      if (!payload) return;
      event.clipboardData.setData("text/html", payload.html);
      event.clipboardData.setData("text/plain", payload.plain);
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy, true);
    };
  }, []);

  const components = useMemo<Components>(
    () => ({
      a: ArtifactLink,
      code: ArtifactInlineCode,
      pre: ArtifactPre,
      table: ({ children }) => (
        <div
          tabIndex={0}
          className="artifact-markdown-table focus:outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <table>{children}</table>
        </div>
      ),
      img: ({ node, src, alt }) => {
        void node;
        if (!src) return alt ? <span>{alt}</span> : null;
        return (
          <img
            src={src}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            onClick={() => {
              if (!window.getSelection()?.isCollapsed) return;
              setZoomedImage({ src, alt: alt ?? "" });
            }}
          />
        );
      },
    }),
    [],
  );

  return (
    <>
      <article
        ref={articleRef}
        data-artifact-markdown=""
        tabIndex={-1}
        className="artifact-markdown rich-text-editor note-format focus:outline-none"
      >
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {source}
        </Markdown>
      </article>
      {zoomedImage && (
        <ReportImageZoom
          src={zoomedImage.src}
          alt={zoomedImage.alt}
          onClose={() => setZoomedImage(null)}
        />
      )}
    </>
  );
});
