import { expect, test } from "bun:test";
import { ProcessTreeOwner } from "#src/platform/process-tree";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";

for (const terminal of [false, true])
  test.skipIf(terminal && process.platform === "win32")(
    `owned auth process closes ${terminal ? "PTY" : "pipes"} and its child on dispose`,
    async () => {
      const process = runtimeAuthProcess(
        new ProcessTreeOwner().spawn(
          [
            Bun.which("bun")!,
            "-e",
            "console.log(JSON.stringify({pid:process.pid,tty:Boolean(process.stdin.isTTY)}));setInterval(()=>{},1000)",
          ],
          import.meta.dir,
          { PATH: Bun.env.PATH ?? "" },
          { terminal },
        ),
      );
      const reader = process.output.getReader();
      try {
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes("\n")) {
          const item = await reader.read();
          if (item.done) throw new Error("fixture exited before reporting its TTY");
          text += decoder.decode(item.value);
        }
        const { pid, tty } = JSON.parse(text.trim());
        expect(tty).toBe(terminal);
        await process.dispose();
        await process.exited;
        expect(() => globalThis.process.kill(pid, 0)).toThrow();
        await process.dispose();
      } finally {
        reader.releaseLock();
        await process.dispose();
      }
    },
    10_000,
  );

for (const terminal of [false, true]) {
  for (const ignoresTerm of [false, true]) {
    test.skipIf(process.platform === "win32")(
      `shared ${terminal ? "PTY" : "pipe"} cleanup ${ignoresTerm ? "escalates after grace" : "lets TERM finish credential writes"}`,
      async () => {
        const tree = new ProcessTreeOwner().spawn(
          [
            process.execPath,
            "-e",
            ignoresTerm
              ? 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'
              : 'process.on("SIGTERM",()=>{console.log("credentials-flushed");process.exit(0)});console.log("ready");setInterval(()=>{},1000)',
          ],
          import.meta.dir,
          { PATH: Bun.env.PATH ?? "" },
          { terminal },
        );
        const auth = runtimeAuthProcess(tree);
        const reader = auth.output.getReader();
        let output = "";
        const read = async () => {
          const item = await reader.read();
          if (!item.done) output += new TextDecoder().decode(item.value);
          return item.done;
        };
        try {
          while (!output.includes("ready")) if (await read()) throw new Error("child exited early");
          const before = Date.now();
          await auth.dispose();
          const elapsed = Date.now() - before;
          while (!(await read())) {
            /* drain final TERM output */
          }
          expect(await auth.exited).toBe(ignoresTerm ? 137 : 0);
          if (ignoresTerm) expect(elapsed).toBeGreaterThanOrEqual(5_000);
          else expect(output).toContain("credentials-flushed");
          expect(() => process.kill(tree.child.pid!, 0)).toThrow();
        } finally {
          reader.releaseLock();
          await auth.dispose();
        }
      },
      15_000,
    );
  }
}
