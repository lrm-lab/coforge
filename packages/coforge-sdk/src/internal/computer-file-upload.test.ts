import { expect, test } from "bun:test";
import {
  COMPUTER_FILE_MAX_BYTES,
  COMPUTER_FILE_PULL_METHOD,
  COMPUTER_FILE_PULL_RESULT_METHOD,
  COMPUTER_FILE_UPLOAD_CAPABILITY,
  decodeComputerFilePullRequest,
  decodeComputerFilePullResult,
  encodeComputerFilePullRequest,
  encodeComputerFilePullResult,
  sanitizeComputerFileName,
  type ComputerFilePullRequest,
  type ComputerFilePullResult,
} from "./computer-file-upload";

const scope = {
  protocolMajor: 1,
  requestId: "req-1",
  workspaceId: "ws-1",
  computerId: "pc-1",
};

const request: ComputerFilePullRequest = {
  ...scope,
  downloadUrl: "https://files.example/object?sig=1",
  fileName: "notes.txt",
  sizeBytes: 12,
  contentType: "text/plain",
};

test("round-trips a computer file pull request and result", () => {
  expect(decodeComputerFilePullRequest(encodeComputerFilePullRequest(request))).toEqual(request);
  const result: ComputerFilePullResult = {
    ...request,
    status: "ok",
    path: "/workspace/uploads/notes.txt",
    errorMessage: "",
  };
  expect(decodeComputerFilePullResult(encodeComputerFilePullResult(result))).toEqual(result);
});

test("exports capability and method names", () => {
  expect(COMPUTER_FILE_UPLOAD_CAPABILITY).toBe("computer-file-upload:v1");
  expect(COMPUTER_FILE_PULL_METHOD).toBe("daemon:v1:computer_file:pull");
  expect(COMPUTER_FILE_PULL_RESULT_METHOD).toBe("daemon:v1:computer_file:pull_result");
  expect(COMPUTER_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
});

test("a Computer file the page accepts fits in one request the web server accepts", () => {
  // The upload passes through the web process, which runs Bun.serve with its default
  // maxRequestBodySize of 128 MiB (https://bun.com/docs/runtime/http/server); the multipart
  // framing adds a little to the file.
  expect(COMPUTER_FILE_MAX_BYTES).toBeLessThan(128 * 1024 * 1024 - 1024 * 1024);
});

test("sanitizes file names and refuses path escape", () => {
  expect(sanitizeComputerFileName("a/b/c.txt")).toBe("c.txt");
  expect(sanitizeComputerFileName("../x")).toBe("x");
  expect(() => sanitizeComputerFileName("..")).toThrow();
  expect(() => sanitizeComputerFileName("")).toThrow();
});

test("refuses non-https download URLs and oversized payloads", () => {
  expect(() =>
    encodeComputerFilePullRequest({ ...request, downloadUrl: "http://files.example/x" }),
  ).toThrow();
  expect(() =>
    encodeComputerFilePullRequest({ ...request, sizeBytes: COMPUTER_FILE_MAX_BYTES + 1 }),
  ).toThrow();
});
