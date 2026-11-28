import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { cn } from "#src/lib/utils";
import type { TerminalAttachMode } from "#src/server/computers/computer-terminal-store.server";
import { readTerminalTheme } from "./computer-terminal-theme";

export type TerminalCanvasHandle = {
  write(bytes: Uint8Array): void;
  reset(): void;
  focus(): void;
  readVisibleText(): string;
};

function handleCopyOrPasteShortcut(event: KeyboardEvent, terminal: Terminal): boolean {
  if (event.type !== "keydown") return true;
  const key = event.key.toLowerCase();
  const isCopyShortcut = (event.metaKey || (event.ctrlKey && event.shiftKey)) && !event.altKey;
  if (isCopyShortcut && key === "c" && terminal.hasSelection()) {
    const selection = terminal.getSelection();
    if (selection && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(selection).catch(() => {});
    }
    return false;
  }
  const isShiftPasteShortcut = event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
  if (isShiftPasteShortcut && key === "v" && navigator.clipboard?.readText) {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) terminal.paste(text);
      })
      .catch(() => {});
    return false;
  }
  return true;
}

export function ComputerTerminalXtermCanvas({
  mode,
  dimensions,
  onReady,
  onResize,
  onData,
  onMountHandle,
  className,
}: {
  mode: TerminalAttachMode;
  dimensions: { cols: number; rows: number } | null;
  onReady: (size: { cols: number; rows: number }) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onData?: (data: string) => void;
  onMountHandle: (handle: TerminalCanvasHandle | null) => void;
  className?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const callbacksRef = useRef({ onReady, onResize, onData, onMountHandle });

  useEffect(() => {
    callbacksRef.current = { onReady, onResize, onData, onMountHandle };
  });

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const container = hostRef.current;
    if (!wrapper || !container) return;

    const readonly = mode === "readonly";
    const initialCols = dimensions?.cols ?? 80;
    const initialRows = dimensions?.rows ?? 24;
    const terminal = new Terminal({
      cols: initialCols,
      rows: initialRows,
      cursorBlink: !readonly,
      cursorInactiveStyle: readonly ? "none" : "outline",
      disableStdin: readonly,
      fontFamily:
        'ui-monospace, "Roboto Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: readonly ? 12 : 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: readTerminalTheme(wrapper),
    });
    terminalRef.current = terminal;

    let fitAddon: FitAddon | null = null;
    if (!readonly) {
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.attachCustomKeyEventHandler((event) => handleCopyOrPasteShortcut(event, terminal));
    }

    terminal.open(container);

    if (readonly) {
      const textarea = container.querySelector("textarea");
      if (textarea) {
        textarea.readOnly = true;
        textarea.inputMode = "none";
        textarea.tabIndex = -1;
        textarea.setAttribute("aria-hidden", "true");
      }
    } else {
      fitAddon?.fit();
      terminal.focus();
    }

    lastSizeRef.current = { cols: terminal.cols, rows: terminal.rows };
    callbacksRef.current.onReady({ cols: terminal.cols, rows: terminal.rows });

    const dataSubscription = readonly
      ? null
      : terminal.onData((data) => {
          callbacksRef.current.onData?.(data);
        });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer =
      !readonly && typeof ResizeObserver !== "undefined" && fitAddon
        ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              fitAddon?.fit();
              const next = { cols: terminal.cols, rows: terminal.rows };
              if (
                next.cols !== lastSizeRef.current.cols ||
                next.rows !== lastSizeRef.current.rows
              ) {
                lastSizeRef.current = next;
                callbacksRef.current.onResize?.(next);
              }
            }, 60);
          })
        : null;
    observer?.observe(container);

    callbacksRef.current.onMountHandle({
      write: (bytes) => {
        terminal.write(bytes);
      },
      reset: () => {
        terminal.reset();
      },
      focus: () => {
        if (!readonly) terminal.focus();
      },
      readVisibleText: () => {
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let row = 0; row < buffer.length; row += 1) {
          const line = buffer.getLine(row);
          if (line) lines.push(line.translateToString(true));
        }
        return lines.join("\n").trimEnd();
      },
    });

    return () => {
      callbacksRef.current.onMountHandle(null);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
      dataSubscription?.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [mode]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || mode !== "readonly" || !dimensions) return;
    if (terminal.cols !== dimensions.cols || terminal.rows !== dimensions.rows) {
      terminal.resize(dimensions.cols, dimensions.rows);
    }
  }, [dimensions?.cols, dimensions?.rows, mode]);

  return (
    <div
      ref={wrapperRef}
      data-terminal-canvas={mode}
      className={cn(
        "relative min-h-0 flex-1 bg-terminal text-terminal-fg",
        mode === "readonly" ? "overflow-auto p-2" : "overflow-hidden p-3",
        className,
      )}
    >
      <div
        ref={hostRef}
        className={cn(mode === "readonly" ? "min-h-full w-max min-w-full" : "h-full w-full")}
      />
    </div>
  );
}
