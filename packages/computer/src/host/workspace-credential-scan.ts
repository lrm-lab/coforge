import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceCredentialFinding = {
  path: string;
  reasons: string[];
  mode: string;
};

export type WorkspaceCredentialScanOptions = {
  maxDepth?: number;
  maxFiles?: number;
  maxBytes?: number;
};

const CREDENTIAL_FILE_NAME =
  /^(?:\.info|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|kdbx)|.*(?:secret|credential|passwd|password|token).*)$/i;

const SKIPPED_DIRECTORY = new Set([
  ".cache",
  ".git",
  ".next",
  "build",
  "dist",
  "node_modules",
  "site-packages",
  "target",
  "venv",
  ".venv",
  "__pycache__",
]);

const CONTENT_RULES: { reason: string; pattern: RegExp }[] = [
  { reason: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "cloud access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { reason: "slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { reason: "provider key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { reason: "basic auth url", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i },
];

const ASSIGNED_SECRET =
  /[\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)[\w.-]*\s*[=:]\s*["']?([\x21-\x7e]{8,})/i;
const REFERENCE_VALUE = /^(?:[\w$]+\.)+[\w$]+$|^[\w$]+\(.*\)$/;

const DEFAULTS = { maxDepth: 4, maxFiles: 5000, maxBytes: 64 * 1024 };

export async function scanWorkspaceCredentials(
  root: string,
  options: WorkspaceCredentialScanOptions = {},
): Promise<WorkspaceCredentialFinding[]> {
  const limits = { ...DEFAULTS, ...options };
  const findings: WorkspaceCredentialFinding[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < limits.maxFiles) {
    const { directory, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= limits.maxFiles) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 < limits.maxDepth && !SKIPPED_DIRECTORY.has(entry.name))
          queue.push({ directory: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const finding = await inspectFile(path, limits.maxBytes);
      if (finding) findings.push(finding);
    }
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectFile(
  path: string,
  maxBytes: number,
): Promise<WorkspaceCredentialFinding | null> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return null;
  }
  if (stats.size > maxBytes * 4) return null;
  const named = CREDENTIAL_FILE_NAME.test(path.slice(path.lastIndexOf("/") + 1));
  const reasons = named ? ["credential file name"] : [];
  const content = await readHead(path, maxBytes);
  if (content !== null) {
    for (const rule of CONTENT_RULES) if (rule.pattern.test(content)) reasons.push(rule.reason);
    if (hasAssignedSecret(content)) reasons.push("assigned secret");
  }
  if (reasons.length === 0) return null;
  return { path, reasons, mode: fileMode(stats.mode) };
}

async function readHead(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.includes(0)) return null;
    return head.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function hasAssignedSecret(content: string): boolean {
  for (const line of content.split("\n")) {
    const match = ASSIGNED_SECRET.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/["',;\s]+$/, "");
    if (value.length === 0 || value.startsWith("$") || value.includes("${")) continue;
    if (!/\d|[^\w\s]/.test(value)) continue;
    if (REFERENCE_VALUE.test(value)) continue;
    return true;
  }
  return false;
}

function fileMode(mode: number): string {
  const type = (mode & 0o170000) === 0o100000 ? "-" : "?";
  const bits = "rwxrwxrwx"
    .split("")
    .map((character, index) => (mode & (0o400 >> index) ? character : "-"))
    .join("");
  return type + bits;
}

export function describeWorkspaceCredentialFinding(finding: WorkspaceCredentialFinding): string {
  return `[workspace-credentials] ${finding.path} (${finding.reasons.join(", ")}, ${finding.mode})`;
}

export async function reportWorkspaceCredentials(
  root: string,
  log: (line: string) => void = console.log,
  options: WorkspaceCredentialScanOptions = {},
): Promise<number> {
  let findings: WorkspaceCredentialFinding[];
  try {
    findings = await scanWorkspaceCredentials(root, options);
  } catch {
    return 0;
  }
  if (findings.length === 0) return 0;
  log(
    `[workspace-credentials] ${findings.length} file(s) under ${root} look like plaintext credentials; anyone with this computer can read them, so keep secrets out of the shared workspace`,
  );
  for (const finding of findings) log(describeWorkspaceCredentialFinding(finding));
  return findings.length;
}
