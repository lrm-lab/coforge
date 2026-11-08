import { getLogger } from "@logtape/logtape";
import { newestLinesWithin, splitsSurrogatePair, STDERR_EXCERPT_MAX_CHARS } from "./stderr-excerpt";
import type { OwnedChildProcess } from "./process-tree";
import { scrubRuntimeErrorText } from "./runtime-error-text";

const logger = getLogger(["coforge", "daemon", "code-agent", "jsonl"]);

/** The UTF-16 length past which a stderr line is reported as oversized. */
const STDERR_LINE_BOUND = 4096;

/**
 * How much of the newest diagnostics the process log keeps, in UTF-16 units, over at most
 * `StderrCapture.TAIL_LINES` lines — the newest line usually fills the budget alone. A person
 * reading the log alone needs to tell an auth refusal from a usage limit, and one line does that;
 * the whole stream never goes to disk — it can carry credentials, paths and user content, and it
 * was the retention window's largest single consumer (`docs/local-logging.md` §6, task #713).
 *
 * Equal to `MAX_VISIBLE_ERROR_CHARS` today, and deliberately not derived from it: this bounds what
 * a disk record may keep, that bounds a user-visible message, and the two are free to diverge.
 */
const STDERR_LOG_SUMMARY_CHARS = 512;

/**
 * How many UTF-16 units of `text[start, end)` fit in `room`, never splitting a surrogate pair: a
 * character that starts inside the room is kept whole, as appending character by character would.
 */
function boundedTake(text: string, start: number, end: number, room: number): number {
  if (end - start <= room) return end - start;
  const cut = start + room;
  return splitsSurrogatePair(text, cut) ? room + 1 : room;
}

/**
 * One code agent process's stderr: the tail kept for attaching to a surfaced error, the listeners
 * an adapter watches, and the bounded summary the daemon log gets when the runtime writes
 * diagnostics. A flood costs the log its byte count and that summary, nothing more, so a wall of
 * chatter cannot grow the log without bound.
 *
 * `finished` settles when the stream ends or the process closes it.
 */
export class StderrCapture {
  static readonly TAIL_LINES = 4;

  /** The last few stderr lines, for attaching to a surfaced error. */
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
    /** This process's logger, already stamped with the launch identity it was spawned under, so a
     * stderr warning is attributable to one Agent and one launch like every other record. */
    private readonly log: typeof logger = logger,
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
    /** The newest diagnostics alone — `#tail` keeps routine lines too — which is what the log's
     * one bounded summary is made of. */
    const diagnosticTail: string[] = [];
    const decoder = new TextDecoder();
    let line = "";
    let oversized = false;
    let diagnostic = "";
    let sawDiagnosticStderr = false;
    /** One reported line: kept for the tail, offered to the log and to every listener. */
    const report = (reported: string) => {
      this.#keep(reported);
      if (reported.trim() && !this.#routineLine?.(reported)) {
        sawDiagnosticStderr = true;
        diagnosticTail.push(reported);
        if (diagnosticTail.length > StderrCapture.TAIL_LINES) diagnosticTail.shift();
      }
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
      if (bytes > 0 && sawDiagnosticStderr)
        this.log.warning("Code agent process wrote diagnostics to stderr", {
          event: "code_agent.process.stderr",
          pid: this.child.pid,
          bytes,
          lines,
          error_message: newestLinesWithin(
            diagnosticTail.map(scrubRuntimeErrorText),
            STDERR_LOG_SUMMARY_CHARS,
          ),
          outcome: "observed",
        });
    } catch {
      // Process exit can close stderr while it is being drained.
    }
  }
}
