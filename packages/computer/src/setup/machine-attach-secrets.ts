import { chmod, link, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "@lrm/coforge-daemon";
import { writePrivateFileAtomic } from "@lrm/coforge-daemon/src/platform/private-file";
import { encodeBase64, decodeBase64 } from "@lrm/coforge-sdk/internal/base64";
import { createAttachKeyPair } from "@lrm/coforge-sdk/internal/computer-attach-proof";
import { resolveComputerCredentialsDirectory } from "@lrm/coforge-sdk/internal/computer-credentials";
import { z } from "zod";

const identityRecord = z.strictObject({
  version: z.literal(1),
  publicKey: z.string().length(44),
  privateKey: z.string().length(44),
});
const pendingRecord = z.strictObject({
  sessionId: z.uuid(),
  pollSecret: z.string().min(1).max(100),
  expiresAt: z.int().positive(),
  userCode: z.string().length(8).optional(),
  verificationUri: z.string().max(4096).optional(),
  binding: z
    .strictObject({
      computerId: z.uuid(),
      workspaceId: z.uuid(),
      workspaceSlug: z.string().min(1).max(200),
    })
    .optional(),
});

export type PendingMachineAttach = z.infer<typeof pendingRecord>;

const pathKey = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readProtected<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0))
      throw new Error("The Computer attach credentials are not in a private regular file.");
    return schema.parse(await Bun.file(path).json());
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

export class FileMachineAttachSecrets {
  readonly #prefix: string;

  constructor(
    serverUrl: string,
    private readonly directory = resolveComputerCredentialsDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: Bun.env,
    }),
  ) {
    this.#prefix = join(directory, `machine-attach-${pathKey(new URL(serverUrl).origin)}`);
  }

  async #ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  async identity() {
    const path = `${this.#prefix}.identity.json`;
    let record = await readProtected(path, identityRecord);
    if (!record) {
      await this.#ensureDirectory();
      const { publicKey, secretKey } = await createAttachKeyPair();
      const generated = {
        version: 1 as const,
        publicKey: encodeBase64(publicKey),
        privateKey: encodeBase64(secretKey),
      };
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(generated), { mode: 0o600, flag: "wx" });
        await link(temporary, path);
        record = generated;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        record = await readProtected(path, identityRecord);
        if (!record) throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const publicKey = decodeBase64(record.publicKey);
    const privateKey = decodeBase64(record.privateKey);
    if (publicKey.length !== 32 || privateKey.length !== 32)
      throw new Error("The Computer attach identity file is invalid.");
    return { publicKey, privateKey };
  }

  async lock() {
    await this.#ensureDirectory();
    return acquireProcessLock(`${this.#prefix}.sqlite`);
  }

  #pendingPath(selector: string) {
    return `${this.#prefix}-${pathKey(selector)}.pending.json`;
  }

  loadPending(selector: string) {
    return readProtected(this.#pendingPath(selector), pendingRecord);
  }

  async savePending(selector: string, pending: PendingMachineAttach) {
    await this.#ensureDirectory();
    await writePrivateFileAtomic(this.#pendingPath(selector), JSON.stringify(pending));
  }

  clearPending(selector: string) {
    return rm(this.#pendingPath(selector), { force: true });
  }
}
