import { withDeadline } from "#src/deadline";

export class LocalSessionDeadlineError extends Error {
  override name = "LocalSessionDeadlineError";
}

export async function localSessionIo<T>(work: Promise<T>, limits: LocalSessionLimits): Promise<T> {
  const outstanding = limits.outstandingIo;
  outstanding?.add(work);
  void work.finally(() => outstanding?.delete(work)).catch(() => {});
  const remaining = Math.floor(limits.deadlineAtMs - limits.now());
  if (remaining <= 0) throw new LocalSessionDeadlineError("Local session scan deadline exceeded");
  return withDeadline(
    work,
    remaining,
    () => new LocalSessionDeadlineError("Local session scan deadline exceeded"),
  );
}

export type LocalSessionLimits = {
  maxResults: number;
  maxDirectories: number;
  maxFiles: number;
  maxContentBytes: number;
  maxFileBytes: number;
  deadlineAtMs: number;
  now(): number;
  /** Still-running I/O from a timed-out scan; shared by one catalog to prevent accumulation. */
  outstandingIo?: Set<Promise<unknown>>;
};

export type NativeLocalSession = {
  sessionId: string;
  cwd: string;
  model: string;
  title: string;
  updatedAtMs: number;
  matchKind: "recent" | "id" | "cwd" | "content";
  snippet: string;
};

export type NativeLocalSessionTurn = {
  role: "user" | "assistant";
  text: string;
  timestampMs: number;
};

export type NativeLocalSessionExcerpt = {
  model: string;
  updatedAtMs: number;
  initialRequest: string;
  recentTurns: NativeLocalSessionTurn[];
};

export type NativeLocalSessionExcerptRead =
  | { status: "ok"; excerpt: NativeLocalSessionExcerpt }
  | { status: "not_found" | "unavailable" };

export type NativeLocalSessionSearch = {
  sessions: NativeLocalSession[];
  scanComplete: boolean;
  contentSearchComplete: boolean;
};

export type LocalSessionSearchOptions = { query: string; limits: LocalSessionLimits };
export type LocalSessionExcerptOptions = {
  sessionId: string;
  cwd: string;
  limits: LocalSessionLimits;
};

export function localSessionText(value: string, max = 8_192): string {
  return value.replaceAll("\0", "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function localSessionField(value: string, max: number): string {
  return value
    .replaceAll("\0", "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}

export function localSessionSnippet(text: string, query: string): string {
  const flat = localSessionText(text, 32_768);
  if (!query) return "";
  const at = flat.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return "";
  return flat.slice(Math.max(0, at - 80), at + query.length + 120).slice(0, 1_000);
}

export function jsonlWindows(head: string, tail: { text: string; startOffset: number }): unknown[] {
  const headLines = head.split("\n");
  if (head.length > 0 && !head.endsWith("\n")) headLines.pop();
  const tailLines = tail.text.split("\n");
  if (tail.startOffset > 0) tailLines.shift();
  const lines = tail.startOffset === 0 ? tailLines : [...headLines, ...tailLines];
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A bounded window may cut a JSONL record at either edge.
    }
  }
  return records;
}

export async function readLocalSessionWindows(
  rootPath: string,
  path: string,
  limits: LocalSessionLimits,
  host: {
    readFileHeadBytes(root: string, path: string, bytes: number): Promise<{ bytes: Uint8Array }>;
    readFileTailBytes(
      root: string,
      path: string,
      bytes: number,
    ): Promise<{ bytes: Uint8Array; startOffset: number }>;
  },
  budget: { bytes: number },
): Promise<{ records: unknown[]; complete: boolean } | undefined> {
  if (budget.bytes <= 0 || limits.now() >= limits.deadlineAtMs) return;
  const allowance = Math.min(limits.maxFileBytes, budget.bytes);
  if (allowance <= 0) return;
  try {
    const headBytes = Math.min(256 * 1024, Math.floor(allowance / 2));
    const tailBytes = Math.max(1, allowance - headBytes);
    const [headRead, tailRead] = await localSessionIo(
      Promise.all([
        host.readFileHeadBytes(rootPath, path, headBytes),
        host.readFileTailBytes(rootPath, path, tailBytes),
      ]),
      limits,
    );
    const head = Buffer.from(headRead.bytes);
    const tail = Buffer.from(tailRead.bytes);
    const windowsCoverFile = tailRead.startOffset === 0 || tailRead.startOffset <= head.byteLength;
    const prefix = head.subarray(0, Math.min(head.byteLength, tailRead.startOffset));
    const decoder = new TextDecoder();
    const bytesRead =
      tailRead.startOffset === 0 ? tail.byteLength : prefix.byteLength + tail.byteLength;
    budget.bytes -= Math.min(allowance, bytesRead);
    return {
      records:
        tailRead.startOffset === 0
          ? jsonlWindows("", { text: decoder.decode(tail), startOffset: 0 })
          : windowsCoverFile
            ? jsonlWindows("", {
                text: decoder.decode(Buffer.concat([prefix, tail])),
                startOffset: 0,
              })
            : jsonlWindows(decoder.decode(prefix), {
                text: decoder.decode(tail),
                startOffset: tailRead.startOffset,
              }),
      complete: windowsCoverFile,
    };
  } catch (error) {
    if (error instanceof LocalSessionDeadlineError) throw error;
    return;
  }
}
