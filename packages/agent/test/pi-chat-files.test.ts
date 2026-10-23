import { expect, test, spyOn } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiChatFiles } from "#src/pi-chat/files";

test("file observations stay inside their directory if an ancestor is replaced during a read", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-directory-race-"));
  const cwd = join(root, "scope"),
    reports = join(cwd, "reports"),
    outside = join(root, "other");
  await mkdir(reports, { recursive: true });
  await mkdir(outside);
  await Bun.write(join(reports, "report.txt"), "own report");
  await Bun.write(join(outside, "report.txt"), "other scope");
  const original = filesystem.open;
  let replaced = false;
  const observation = spyOn(filesystem, "open").mockImplementation(async (...args) => {
    if (!replaced && String(args[0]).endsWith("/report.txt")) {
      replaced = true;
      await rename(reports, reports + "-original");
      await symlink(outside, reports);
    }
    return original(...args);
  });
  try {
    const result = await new PiChatFiles(cwd).execute({
      action: "file",
      path: "reports/report.txt",
    });
    expect(replaced).toBe(true);
    expect(Buffer.from(result.file!.data, "base64").toString()).toBe("own report");
  } finally {
    observation.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("browses real working files, reads generated output, and refuses reserved or outside paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-files-"));
  try {
    const cwd = join(root, "scope");
    await mkdir(cwd);
    await mkdir(join(cwd, "reports"));
    await mkdir(join(cwd, ".chat-index"));
    await Bun.write(join(cwd, "reports", "结果.md"), "# Result\nHello");
    await Bun.write(join(root, "private.txt"), "private");
    await symlink(root, join(cwd, "outside"));
    const files = new PiChatFiles(cwd);
    const listing = await files.execute({ action: "files", path: "" });
    expect(listing.directory?.root).toBe(cwd);
    expect(listing.directory?.entries.map((entry) => entry.name)).toEqual(["reports"]);
    const read = await files.execute({ action: "file", path: "reports/结果.md" });
    expect(Buffer.from(read.file!.data, "base64").toString()).toBe("# Result\nHello");
    expect(read.file?.status).toBe("ok");
    expect(
      (await files.execute({ action: "file", path: join(cwd, "reports/结果.md") })).file?.path,
    ).toBe("reports/结果.md");
    for (const path of [
      "../private.txt",
      "outside/private.txt",
      ".chat-index/secret",
      ".pi-sessions/secret",
      "reports/../../private.txt",
    ])
      await expect(files.execute({ action: "file", path })).rejects.toThrow();
    await expect(files.execute({ action: "files", path: "outside" })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads chunks without overwriting files; retries are idempotent and input is bounded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-upload-"));
  try {
    const files = new PiChatFiles(cwd);
    const uploadId = crypto.randomUUID();
    const first = {
      action: "upload" as const,
      uploadId,
      name: "计划.txt",
      offset: 0,
      total: 6,
      data: Buffer.from("abc").toString("base64"),
    };
    expect((await files.execute(first)).uploaded).toBeUndefined();
    expect((await files.execute(first)).uploaded).toBeUndefined();
    const last = { ...first, offset: 3, data: Buffer.from("def").toString("base64") };
    const result = await files.execute(last);
    expect(result.uploaded).toBe(`uploads/${uploadId}-计划.txt`);
    expect((await files.execute(last)).uploaded).toBe(result.uploaded);
    expect(await Bun.file(join(cwd, result.uploaded!)).text()).toBe("abcdef");
    await expect(
      files.execute({ ...first, name: "../secret", uploadId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(
      files.execute({ ...first, total: 30_000_000, uploadId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(
      files.execute({ ...first, offset: 2, uploadId: crypto.randomUUID() }),
    ).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("binary downloads preserve bytes, and large files are reported without reading all content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-download-"));
  try {
    const files = new PiChatFiles(cwd);
    const data = new Uint8Array([0, 1, 2, 255]);
    await Bun.write(join(cwd, "sample.bin"), data);
    const result = await files.execute({ action: "file", path: "sample.bin" });
    expect(new Uint8Array(Buffer.from(result.file!.data, "base64"))).toEqual(data);
    expect(result.file?.status).toBe("binary");
    await Bun.write(join(cwd, "large.bin"), new Uint8Array(10_485_761));
    const large = await files.execute({ action: "file", path: "large.bin" });
    expect(large.file?.status).toBe("too_large");
    expect(large.file?.data).toBe("");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed uploads release their buffers and slots so an upload can restart after a directory repair", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-upload-retry-"));
  try {
    const files = new PiChatFiles(cwd);
    await Bun.write(join(cwd, "uploads"), "not a directory");
    const input = {
      action: "upload" as const,
      uploadId: crypto.randomUUID(),
      name: "retry.txt",
      offset: 0,
      total: 1,
      data: "YQ==",
    };
    for (let index = 0; index < 4; index++)
      await expect(files.execute({ ...input, uploadId: crypto.randomUUID() })).rejects.toThrow();
    await rm(join(cwd, "uploads"));
    const result = await files.execute(input);
    expect(await Bun.file(join(cwd, result.uploaded!)).text()).toBe("a");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
