import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  PI_CHAT_FILE_MAX_BYTES,
  piChatCommandSchema,
  type PiChatCommand,
  type PiChatResult,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { PI_SESSION_DIR } from "#src/paths";

const reserved = new Set([PI_SESSION_DIR, ".chat-index"]);
type Upload = {
  name: string;
  total: number;
  received: number;
  bytes?: Buffer;
  updatedAt: number;
  result?: Promise<string>;
};

/** Files belong to the same private User/Workspace working directory as native Pi tools. */
export class PiChatFiles {
  readonly #uploads = new Map<string, Upload>();
  constructor(private readonly cwd: string) {}

  #location(path: string) {
    const root = resolve(this.cwd);
    const local = isAbsolute(path) ? relative(root, path) : path;
    if (
      local.includes("\\") ||
      local.includes("\0") ||
      local.split("/").some((part) => part === ".." || reserved.has(part))
    )
      throw new Error("File path unavailable");
    return {
      root,
      path: local
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/"),
    };
  }

  async #directory(path: string) {
    // Cloud Computers are Linux. Pin every ancestor instead of validating a path
    // then following it again after an asynchronous boundary.
    if (process.platform !== "linux") throw new Error("Cloud files require Linux");
    const location = this.#location(path);
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let handle = await open(sep, flags);
    try {
      for (const part of [
        ...location.root.split(sep).filter(Boolean),
        ...location.path.split("/").filter(Boolean),
      ]) {
        const next = await open(`/proc/self/fd/${handle.fd}/${part}`, flags);
        await handle.close();
        handle = next;
      }
      return { ...location, handle, full: `/proc/self/fd/${handle.fd}` };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async execute(
    input: Extract<PiChatCommand, { action: "files" | "file" | "upload" }>,
  ): Promise<PiChatResult> {
    const command = piChatCommandSchema.parse(input);
    if (command.action === "upload") return this.#upload(command);
    if (command.action !== "files" && command.action !== "file")
      throw new Error("Invalid file command");
    const location = this.#location(command.path);
    if (command.action === "files") {
      const directory = await this.#directory(command.path);
      try {
        const entries: NonNullable<PiChatResult["directory"]>["entries"] = [];
        const names = await readdir(directory.full, { withFileTypes: true });
        for (const entry of names) {
          if (
            reserved.has(entry.name) ||
            (!command.hidden && entry.name.startsWith(".")) ||
            entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())
          )
            continue;
          try {
            const info = await lstat(resolve(directory.full, entry.name));
            entries.push({
              name: entry.name,
              directory: info.isDirectory(),
              size: info.size,
              modifiedAt: info.mtimeMs,
            });
          } catch {
            /* Files can disappear while tools run. */
          }
        }
        entries.sort(
          (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
        );
        return { directory: { root: location.root, path: location.path, entries } };
      } finally {
        await directory.handle.close();
      }
    }
    const parts = location.path.split("/");
    const name = parts.pop()!;
    const directory = await this.#directory(parts.join("/"));
    let handle;
    try {
      handle = await open(
        `${directory.full}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } finally {
      await directory.handle.close();
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("File path unavailable");
      if (info.size > PI_CHAT_FILE_MAX_BYTES)
        return { file: { path: location.path, size: info.size, status: "too_large", data: "" } };
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const content = bytes.subarray(0, offset);
      return {
        file: {
          path: location.path,
          size: offset,
          status: content.includes(0) ? "binary" : "ok",
          data: content.toString("base64"),
        },
      };
    } finally {
      await handle.close();
    }
  }

  async #upload(command: Extract<PiChatCommand, { action: "upload" }>): Promise<PiChatResult> {
    if (command.name === "." || command.name === "..") throw new Error("Invalid upload name");
    for (const [id, upload] of this.#uploads)
      if (Date.now() - upload.updatedAt > 300_000) this.#uploads.delete(id);
    let upload = this.#uploads.get(command.uploadId);
    if (!upload) {
      if (
        command.offset !== 0 ||
        this.#uploads.size >= 32 ||
        [...this.#uploads.values()].filter((item) => item.bytes).length >= 4
      )
        throw new Error("Upload unavailable");
      upload = {
        name: command.name,
        total: command.total,
        received: 0,
        bytes: Buffer.alloc(command.total),
        updatedAt: Date.now(),
      };
      this.#uploads.set(command.uploadId, upload);
    }
    if (upload.name !== command.name || upload.total !== command.total)
      throw new Error("Upload mismatch");
    upload.updatedAt = Date.now();
    if (upload.result) return { uploaded: await upload.result };
    const bytes = Buffer.from(command.data, "base64");
    const end = command.offset + bytes.length;
    if (
      end > upload.total ||
      command.offset > upload.received ||
      (command.offset < upload.received &&
        (end > upload.received || !upload.bytes!.subarray(command.offset, end).equals(bytes)))
    )
      throw new Error("Upload offset mismatch");
    bytes.copy(upload.bytes!, command.offset);
    upload.received = Math.max(upload.received, end);
    if (upload.received !== upload.total) return { ok: true };
    const completed = upload;
    completed.result = this.#finishUpload(command.uploadId, completed).catch((error: unknown) => {
      this.#uploads.delete(command.uploadId);
      throw error;
    });
    return { uploaded: await completed.result };
  }

  async #finishUpload(id: string, upload: Upload) {
    try {
      const root = await this.#directory("");
      let directory;
      try {
        await mkdir(`${root.full}/uploads`, { recursive: true });
        directory = await open(
          `${root.full}/uploads`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } finally {
        await root.handle.close();
      }
      try {
        const parent = `/proc/self/fd/${directory.fd}`;
        const temporary = `${parent}/.${id}.upload`;
        const name = `${id}-${upload.name}`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          try {
            await handle.writeFile(upload.bytes!);
          } finally {
            await handle.close();
          }
          // Publish a complete file without replacing anything already at its destination.
          await link(temporary, `${parent}/${name}`);
        } finally {
          await unlink(temporary);
        }
        return `uploads/${name}`;
      } finally {
        await directory.close();
      }
    } finally {
      upload.bytes = undefined;
    }
  }
}
