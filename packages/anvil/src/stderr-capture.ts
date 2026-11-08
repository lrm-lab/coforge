import { getLogger } from "@logtape/logtape";
import { redactCredentials } from "@lrm/coforge-sdk/internal";
import { newestLinesWithin, STDERR_EXCERPT_MAX_CHARS } from "./stderr-excerpt";
import type { OwnedChildProcess } from "./process-tree";
import { scrubRuntimeErrorText } from "./runtime-error-text";

const logger = getLogger(["coforge", "daemon", "code-agent", "jsonl"]);

/** The UTF-16 length past which a stderr line is reported as oversized. */
const STDERR_LINE_BOUND = 4096;

/** How many leading reported stderr lines the process log keeps when a runtime floods it. */
const STDERR_LOG_HEAD_LINES = 100;

/** How many trailing reported stderr lines the process log keeps besides the head. */
const STDERR_LOG_TAIL_LINES = 50;

/**
 * How many UTF-16 units of `text[start, end)` fit in `room`, never splitting a surrogate pair: a
 * character that starts inside the room is kept whole, as appending character by character would.
 */
function boundedTake(text: string, start: number, end: number, room: number): number {
  if (end - start <= room) return end - start;
  const cut = start + room;
  const high = text.charCodeAt(cut - 1);
  const low = text.charCodeAt(cut);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? room + 1 : room;
}

/**
 * One code agent process's stderr: the tail kept for a failure message or a surfaced error, the
 * listeners an adapter watches, and the single line the daemon log gets when the runtime writes
 * diagnostics. A flood is reported as its head, an omitted count and its tail, so a wall of
 * chatter cannot bury why the process started or how it ended.
 *
 * `finished` settles when the stream ends or the process closes it.
 */
export class StderrCapture {
  static readonly TAIL_LINES = 4;

  /** The last few stderr lines, for the failure log and for attaching to a surfaced error. */
  readonly #tail: string[] = [];
  readonly #listeners = new Set<(line: string) => void>();
  /** Lines the runtime writes as routine narrative on every run; stderr holding only those is
   * not worth a warning. */
  readonly #routineLine: ((line: string) => boolean) | undefined;
  readonly finished: Promise<void>;

  constructor(
    private readonly child: OwnedChildProcess,
    routineLine?: (line: string) => boolean,
    onDiagnostic?: (diagnostic: string) => void,
  ) {
    this.#routineLine = routineLine;
    this.finished = this.#discard(onDiagnostic);
  }

  onLine(listener: (line: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What stderr has said so far, secrets stripped and capped. Empty until a non-empty line arrives. */
  excerpt(): string {
    if (this.#tail.length === 0) return "";
    return newestLinesWithin(this.#tail.map(scrubRuntimeErrorText), STDERR_EXCERPT_MAX_CHARS);
  }

  /** Forgets every listener, as a closed process does. */
  clearListeners(): void {
    this.#listeners.clear();
  }

  #keep(reported: string): void {
    if (!reported.trim()) return;
    this.#tail.push(reported);
    if (this.#tail.length > StderrCapture.TAIL_LINES) this.#tail.shift();
  }

  async #discard(onDiagnostic?: (diagnostic: string) => void): Promise<void> {
    let bytes = 0;
    let lines = 0;
    const logHead: string[] = [];
    const logTail: string[] = [];
    let loggedLines = 0;
    const keepForLog = (reported: string) => {
      if (!reported.trim()) return;
      loggedLines++;
      if (logHead.length < STDERR_LOG_HEAD_LINES) {
        logHead.push(reported);
        return;
      }
      logTail.push(reported);
      if (logTail.length > STDERR_LOG_TAIL_LINES) logTail.shift();
    };
    const decoder = new TextDecoder();
    let line = "";
    let oversized = false;
    let diagnostic = "";
    let sawDiagnosticStderr = false;
    /** One reported line: kept for the tail, offered to the log and to every listener. */
    const report = (reported: string) => {
      this.#keep(reported);
      if (reported.trim() && !this.#routineLine?.(reported)) sawDiagnosticStderr = true;
      keepForLog(reported);
      for (const listener of this.#listeners) listener(reported);
    };
    try {
      for await (const chunk of this.child.stderr) {
        bytes += chunk.byteLength;
        const text = decoder.decode(chunk, { stream: true });
        if (onDiagnostic) {
          diagnostic = (diagnostic + text).slice(-16_384);
          onDiagnostic(diagnostic);
        }
        // Take each newline-separated run with one slice rather than one string append per
        // character: a line keeps whole characters until it reaches the bound, then is oversized.
        let start = 0;
        while (start <= text.length) {
          const newline = text.indexOf("\n", start);
          const end = newline < 0 ? text.length : newline;
          if (end > start) {
            if (line.length >= STDERR_LINE_BOUND) {
              oversized = true;
            } else {
              const take = boundedTake(text, start, end, STDERR_LINE_BOUND - line.length);
              line += text.slice(start, start + take);
              if (start + take < end) oversized = true;
            }
          }
          if (newline < 0) break;
          lines++;
          report(oversized ? "[oversized stderr diagnostic]" : line.replace(/\r$/, ""));
          line = "";
          oversized = false;
          start = newline + 1;
        }
      }
      const tail = decoder.decode();
      if (tail && onDiagnostic) onDiagnostic((diagnostic + tail).slice(-16_384));
      if (line) report(oversized ? "[oversized stderr diagnostic]" : line);
      const omitted = loggedLines - logHead.length - logTail.length;
      const logged = [
        ...logHead,
        ...(omitted > 0 ? [`[${omitted} stderr lines omitted]`] : []),
        ...logTail,
      ];
      const excerpt = this.excerpt();
      if (bytes > 0 && sawDiagnosticStderr)
        logger.warning("Code agent process wrote diagnostics to stderr", {
          event: "code_agent.process.stderr",
          pid: this.child.pid,
          bytes,
          lines,
          ...(excerpt ? { error_message: excerpt } : {}),
          ...(logged.length > 0 ? { stderr: redactCredentials(logged.join("\n")) } : {}),
          outcome: "observed",
        });
    } catch {
      // Process exit can close stderr while it is being drained.
    }
  }
}
