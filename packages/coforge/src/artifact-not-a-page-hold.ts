import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellWord, type LocalFile } from "#src/artifact-directory";
import { CliError } from "#src/cli-error";

const HOLD_TTL_MS = 10 * 60 * 1000;
const PAGE_EXTENSION = /(?:^|\/)[^/]+\.(?:html?|md|markdown)$/i;
const MAX_SHOWN_FILES = 6;

function holdFilePath(): string {
  if (Bun.env.COFORGE_ARTIFACT_HOLD_FILE) return Bun.env.COFORGE_ARTIFACT_HOLD_FILE;
  const uid = typeof process.geteuid === "function" ? String(process.geteuid()) : "user";
  return join(tmpdir(), `coforge-artifact-holds-${uid}`, "holds.json");
}

function notAPageKey(dir: string, target: string, files: readonly LocalFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = JSON.stringify([
    "artifact-not-a-page/1",
    dir,
    target.trim(),
    sorted.map((file) => [file.path, file.sha256]),
  ]);
  return new Bun.CryptoHasher("sha256").update(payload).digest("hex");
}

async function readHolds(path: string, now: number): Promise<Record<string, number>> {
  const active: Record<string, number> = Object.create(null);
  try {
    const parsed = (await Bun.file(path).json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return active;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && value <= now && now - value <= HOLD_TTL_MS) {
        active[key] = value;
      }
    }
    return active;
  } catch {
    return active;
  }
}

async function writeHoldsAtomic(path: string, holds: Record<string, number>): Promise<boolean> {
  const dir = dirname(path);
  const temp = join(dir, `.holds.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(holds), { mode: 0o600 });
    await rename(temp, path);
    return true;
  } catch {
    await unlink(temp).catch(() => undefined);
    return false;
  }
}

export async function enforceNotAPageHold(input: {
  dir: string;
  target: string;
  files: ReadonlyMap<string, LocalFile>;
  now?: () => number;
}): Promise<void> {
  const list = [...input.files.values()];
  if (list.length === 0) return;
  if (list.some((file) => PAGE_EXTENSION.test(file.path))) return;
  const now = (input.now ?? Date.now)();
  const path = holdFilePath();
  const key = notAPageKey(input.dir, input.target, list);
  const holds = await readHolds(path, now);
  if (typeof holds[key] === "number") return;
  holds[key] = now;
  if (!(await writeHoldsAtomic(path, holds))) return;
  const names = list.map((file) => file.path).sort();
  const shown =
    names.length <= MAX_SHOWN_FILES
      ? names.join(", ")
      : `${names.slice(0, MAX_SHOWN_FILES).join(", ")} (+${names.length - MAX_SHOWN_FILES} more)`;
  throw new CliError({
    code: "ARTIFACT_NOT_A_PAGE",
    message: `Held — not pushed. None of the files (${shown}) is an HTML or Markdown page; plain files, images, PDFs, and CSVs are usually sent as attachments instead of versioned artifacts.`,
    suggestedNextAction: `To send as an attachment: coforge attachment upload --path <file> --target ${shellWord(input.target)}. If you intentionally want a versioned artifact, run the same \`coforge artifact push\` command again within 10 minutes.`,
    retryable: false,
  });
}
