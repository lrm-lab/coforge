import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryStateDirectory = () => {
  const path = join(tmpdir(), `coforge-legacy-path-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
};

test("a legacy file reached through a link is refused, never imported", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = temporaryStateDirectory();
  const elsewhere = temporaryStateDirectory();
  const legacyDirectory = join(
    legacyRoot,
    `coforge-cli-consumed-seq-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    "agent-1",
  );
  await mkdir(legacyDirectory, { recursive: true });
  const real = join(elsewhere, "planted.json");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(
    real,
    JSON.stringify({ targets: { "@ada": { conversationId: "conversation-1", seq: 7 } } }),
  );
  const planted = join(legacyDirectory, "consumed-seqs.json");
  await symlink(real, planted);
  const previous = Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = legacyRoot;
    // The temp root is world-writable: a file another user can plant must never become a cursor.
    expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").targets).toEqual({});
    expect(existsSync(planted)).toBe(true);
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
    else Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = previous;
  }
});

test("imports a legacy file when only the CoForge and Agent directories are owned by us", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = realpathSync("/tmp");
  const agentId = `agent-${crypto.randomUUID()}`;
  const cliDirectory = join(
    legacyRoot,
    `coforge-cli-consumed-seq-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
  );
  const legacyDirectory = join(
    cliDirectory,
    agentId,
  );
  directories.push(legacyDirectory);
  await mkdir(legacyDirectory, { recursive: true });
  const legacyPath = join(legacyDirectory, "consumed-seqs.json");
  await writeFile(
    legacyPath,
    JSON.stringify({ targets: { "@ada": { conversationId: "conversation-1", seq: 7 } } }),
  );
  const previous = Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = legacyRoot;
    expect(new AgentConsumedSeqStore(stateDirectory).read(agentId).targets).toEqual({
      "@ada": { conversationId: "conversation-1", seq: 7 },
    });
    expect(existsSync(legacyPath)).toBe(false);
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
    else Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = previous;
  }
});
