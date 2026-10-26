// The descendant has its own session and ignores the two signals that ordinary relay teardown sends.
if (Bun.argv.includes("child")) {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  console.log("ready");
  setInterval(() => {}, 1000);
} else {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  const escaped = Bun.spawn([process.execPath, import.meta.path, "child"], {
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = escaped.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  process.stdout.write(`${escaped.pid}\n`);
  setInterval(() => {}, 1000);
}
