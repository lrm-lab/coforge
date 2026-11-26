import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeBackoffStore } from "#src/persistence/agent-runtime-backoff-store";
import { ClaudeModelQuotaLedger } from "#src/persistence/claude-model-quota-ledger";

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const NOW = Date.UTC(2026, 10, 26);
const HOUR = 60 * 60_000;

const fable = {
  accountDigest: ACCOUNT_A,
  model: "fable",
  untilMs: NOW + HOUR,
  observedAtMs: NOW,
} as const;

async function withState(run: (state: string) => Promise<void> | void): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), "coforge-claude-quota-"));
  try {
    await run(state);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

test("a guarded weekly window survives a new ledger owner and remains scoped to the account and model", async () => {
  await withState(async (state) => {
    const writer = new ClaudeModelQuotaLedger(state, NOW);
    expect(writer.noteRejected(fable, NOW)).toBe(true);
    expect(writer.noteRejected({ ...fable, accountDigest: ACCOUNT_B, model: "sonnet" }, NOW)).toBe(
      true,
    );

    const path = join(state, "claude-model-quota.json");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toEqual({
      version: 1,
      records: [fable, { ...fable, accountDigest: ACCOUNT_B, model: "sonnet" }],
    });
    expect(new AgentRuntimeBackoffStore(() => state, "old-reader").list()).toEqual([]);

    const reader = new ClaudeModelQuotaLedger(state, NOW + 1);
    expect(reader.active(ACCOUNT_A, "fable", NOW + 1)).toEqual(fable);
    expect(reader.active(ACCOUNT_A, "sonnet", NOW + 1)).toBeUndefined();
    expect(reader.active(ACCOUNT_B, "fable", NOW + 1)).toBeUndefined();
    expect(reader.active(undefined, "fable", NOW + 1)).toBeUndefined();
    expect(reader.active(ACCOUNT_B, "sonnet", NOW + 1)?.untilMs).toBe(fable.untilMs);

    expect(reader.active(ACCOUNT_A, "fable", fable.untilMs)).toBeUndefined();
    expect(
      new ClaudeModelQuotaLedger(state, NOW + 1).active(ACCOUNT_A, "fable", NOW + 1),
    ).toBeUndefined();
  });
});

test("only fresh matching availability releases a weekly window, and release survives restart", async () => {
  await withState((state) => {
    const ledger = new ClaudeModelQuotaLedger(state, NOW);
    expect(ledger.noteRejected(fable, NOW)).toBe(true);
    const duplicate = { ...fable, observedAtMs: NOW + 10 };
    expect(ledger.noteRejected(duplicate, NOW + 10)).toBe(true);
    const latest = { ...duplicate, untilMs: fable.untilMs + 10, observedAtMs: NOW + 20 };
    expect(ledger.noteRejected(latest, NOW + 20)).toBe(true);
    expect(ledger.noteRejected({ ...fable, observedAtMs: NOW + 21 }, NOW + 21)).toBe(false);
    expect(
      ledger.noteRejected(
        { ...latest, untilMs: latest.untilMs + 5, observedAtMs: NOW + 19 },
        NOW + 21,
      ),
    ).toBe(false);

    const restored = new ClaudeModelQuotaLedger(state, NOW + 30);
    const available = { ...latest, observedAtMs: NOW + 30 };
    expect(restored.active(ACCOUNT_A, "fable", NOW + 30)).toEqual(latest);
    for (const evidence of [
      { ...available, accountDigest: ACCOUNT_B },
      { ...available, model: "sonnet" as const },
      { ...available, untilMs: fable.untilMs },
      { ...available, observedAtMs: NOW + 19 },
      latest,
      { ...available, observedAtMs: NOW + 31 },
    ]) {
      expect(restored.noteAvailable(evidence, NOW + 30)).toBe(false);
    }
    expect(restored.noteAvailable(available, NOW + 30)).toBe(true);
    expect(restored.noteAvailable(available, NOW + 30)).toBe(false);
    expect(
      new ClaudeModelQuotaLedger(state, NOW + 31).active(ACCOUNT_A, "fable", NOW + 31),
    ).toBeUndefined();
  });
});

test("invalid persisted records and invalid observations cannot create a hold", async () => {
  await withState(async (state) => {
    const path = join(state, "claude-model-quota.json");
    await writeFile(path, "{malformed");
    expect(new ClaudeModelQuotaLedger(state, NOW).active(ACCOUNT_A, "fable", NOW)).toBeUndefined();

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        records: [
          { ...fable, accountDigest: "unverified-account" },
          { ...fable, model: "custom" },
          { ...fable, untilMs: NOW },
          { ...fable, observedAtMs: NOW + 1 },
          { ...fable, untilMs: NOW + 9 * 24 * HOUR },
        ],
      }),
    );
    const ledger = new ClaudeModelQuotaLedger(state, NOW);
    expect(ledger.active(ACCOUNT_A, "fable", NOW)).toBeUndefined();
    expect(ledger.noteRejected({ ...fable, accountDigest: "unverified-account" }, NOW)).toBe(false);
    expect(ledger.noteRejected({ ...fable, untilMs: Number.NaN }, NOW)).toBe(false);
    expect(ledger.noteRejected(fable, NOW)).toBe(true);
    expect(ledger.active(ACCOUNT_A, "fable", NOW)).toEqual(fable);
  });
});

test("a rejected model window survives abrupt termination of its writer", async () => {
  await withState(async (state) => {
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { ClaudeModelQuotaLedger } from "./src/persistence/claude-model-quota-ledger";
          const [state, fact] = process.argv.slice(-2);
          const record = JSON.parse(fact);
          const accepted = new ClaudeModelQuotaLedger(state, record.observedAtMs)
            .noteRejected(record, record.observedAtMs);
          if (!accepted) process.exit(1);
          console.log("recorded");
          setInterval(() => {}, 60_000);
        `,
        state,
        JSON.stringify(fable),
      ],
      { cwd: join(import.meta.dir, ".."), env: {}, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = writer.stdout.getReader();
    try {
      const { value } = await stdout.read();
      expect(new TextDecoder().decode(value).trim()).toBe("recorded");
      writer.kill("SIGKILL");
      await writer.exited;
      const restored = new ClaudeModelQuotaLedger(state, NOW + 1);
      expect(restored.active(ACCOUNT_A, "fable", NOW + 1)).toEqual(fable);
    } finally {
      writer.kill();
      await writer.exited;
      stdout.releaseLock();
    }
  });
});
