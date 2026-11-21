import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";

test("parses attachment view with an output path", () => {
  expect(
    parseArgs(["attachment", "view", "--id", "attachment-1", "--output", "/tmp/file.txt"]),
  ).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
  });
});

test("parses attachment view with a positional id", () => {
  expect(parseArgs(["attachment", "view", "attachment-1", "--output", "/tmp/file.txt"])).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
  });
});

test("parses attachment view --json", () => {
  expect(
    parseArgs(["attachment", "view", "attachment-1", "--output", "/tmp/file.txt", "--json"]),
  ).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
    json: true,
  });
});

test("attachment view rejects both a positional id and --id", () => {
  expect(() =>
    parseArgs(["attachment", "view", "attachment-1", "--id", "attachment-2", "--output", "/tmp/f"]),
  ).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "attachment-1", "--id", "attachment-2", "--output", "/tmp/f"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe(
      "pass the attachment id either positionally or with --id, not both",
    );
  }
});

test("attachment view rejects a missing id with the exact code and message", () => {
  expect(() => parseArgs(["attachment", "view", "--output", "/tmp/file.txt"])).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "--output", "/tmp/file.txt"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe(
      "attachment id is required (pass <attachmentId> or --id)",
    );
  }
});

test("attachment view rejects a missing --output with the exact code and message", () => {
  expect(() => parseArgs(["attachment", "view", "attachment-1"])).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "attachment-1"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe("--output is required");
  }
});

test("dispatches attachment view and prints the exact download-destination line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const output = join(dir, "downloaded.txt");
  try {
    const result = await run(["attachment", "view", "attachment-1", "--output", output], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => ({ bytes: new TextEncoder().encode("hello") }),
    });
    expect(result).toBe(`Downloaded to: ${output}`);
    expect(await Bun.file(output).text()).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment view --json prints the attachment id and output path as an object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const output = join(dir, "downloaded.txt");
  try {
    const result = await run(["attachment", "view", "attachment-1", "--output", output, "--json"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => ({ bytes: new TextEncoder().encode("hello") }),
    });
    expect(JSON.parse(result as string)).toEqual({ attachmentId: "attachment-1", path: output });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses attachment upload with target, mime type, and --json", () => {
  expect(
    parseArgs(["attachment", "upload", "--path", "/tmp/file.txt", "--target", "@ada"]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "@ada",
    mimeType: undefined,
  });
  expect(
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--mime-type",
      "image/png",
      "--json",
    ]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "@ada",
    mimeType: "image/png",
    json: true,
  });
});

test("parses attachment upload's legacy --channel alias for --target", () => {
  expect(
    parseArgs(["attachment", "upload", "--path", "/tmp/file.txt", "--channel", "#general"]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "#general",
    mimeType: undefined,
  });
});

test("rejects attachment upload given both --target and --channel, even when equal", () => {
  expect(() =>
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--channel",
      "@ada",
    ]),
  ).toThrow("Usage:");
  expect(() =>
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--channel",
      "#other",
    ]),
  ).toThrow("Usage:");
});

test("dispatches attachment upload through the injected transport with an inferred mime type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const calls: unknown[] = [];
    const result = await run(["attachment", "upload", "--path", path, "--target", "@ada"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => {
        throw new Error("unused");
      },
      upload: async (input) => {
        calls.push(input);
        return {
          id: "attachment-1",
          fileName: "note.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        };
      },
    });
    expect(calls).toEqual([{ path, target: "@ada", mimeType: "text/plain" }]);
    expect(result).toBe(
      "File uploaded: note.txt (0.0KB)\n" +
        "Attachment ID: attachment-1\n\n" +
        "Use this ID with coforge message send --attachment-id attachment-1 to include it in a message.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment upload --json prints the raw response object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const path = join(dir, "image.png");
  await writeFile(path, "fake-png-bytes");
  try {
    const result = await run(
      ["attachment", "upload", "--path", path, "--target", "#general", "--json"],
      {
        check: async () => {
          throw new Error("unused");
        },
        read: async () => {
          throw new Error("unused");
        },
        send: async () => {
          throw new Error("unused");
        },
        view: async () => {
          throw new Error("unused");
        },
        upload: async () => ({
          id: "attachment-1",
          fileName: "image.png",
          contentType: "image/png",
          sizeBytes: 14,
        }),
      },
    );
    expect(JSON.parse(result as string)).toEqual({
      id: "attachment-1",
      fileName: "image.png",
      contentType: "image/png",
      sizeBytes: 14,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment upload rejects local preconditions before any transport call", async () => {
  const transport = {
    check: async () => {
      throw new Error("unused");
    },
    read: async () => {
      throw new Error("unused");
    },
    send: async () => {
      throw new Error("unused");
    },
    view: async () => {
      throw new Error("unused");
    },
    upload: async () => {
      throw new Error("must not upload: a local precondition failed");
    },
  };
  await expect(run(["attachment", "upload", "--target", "@ada"], transport)).rejects.toMatchObject({
    code: "INVALID_ARG",
    message: "--path is required",
  });
  await expect(
    run(
      ["attachment", "upload", "--path", "/tmp/coforge-does-not-exist.bin", "--target", "@ada"],
      transport,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARG" });

  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  try {
    const emptyPath = join(dir, "empty.txt");
    await writeFile(emptyPath, "");
    await expect(
      run(["attachment", "upload", "--path", emptyPath, "--target", "@ada"], transport),
    ).rejects.toMatchObject({
      code: "INVALID_ARG",
      message: "--path is empty; refusing to upload a 0-byte attachment",
    });
    await expect(
      run(["attachment", "upload", "--path", dir, "--target", "@ada"], transport),
    ).rejects.toMatchObject({ code: "INVALID_ARG" });

    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello");
    await expect(
      run(
        [
          "attachment",
          "upload",
          "--path",
          filePath,
          "--target",
          "@ada",
          "--mime-type",
          "not-a-mime-type",
        ],
        transport,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARG",
      message: "--mime-type must look like type/subtype, got: not-a-mime-type",
    });
    // Missing --target surfaces after the path checks, as MISSING_CHANNEL, and wins
    // over a bad --mime-type since the target check runs first.
    await expect(
      run(
        ["attachment", "upload", "--path", filePath, "--mime-type", "not-a-mime-type"],
        transport,
      ),
    ).rejects.toMatchObject({
      code: "MISSING_CHANNEL",
      message:
        "A target is required to attach the upload to. Pass --target '#name', '@user', or a thread target.",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
