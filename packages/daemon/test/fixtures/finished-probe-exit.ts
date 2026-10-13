/**
 * Runs one runtime probe that finishes at once, then returns: the process must exit as soon as
 * the probe has, not once the probe's timeout would have passed. `bun --version` stands in for a
 * provider CLI. The argument picks the probe: `inventory`, `catalog-command`, or `version-gate`.
 */
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { runCatalogCommand } from "#src/code-agent/catalog-command";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { cliVersionGate } from "#src/code-agent/version-gate";

const mode = Bun.argv[2];
if (mode === "inventory") {
  // Codex goes through its provider probe; Antigravity through the `--version` output.
  await discoverExternalCodeAgents(
    {
      which: (name) => (name === "codex" || name === "agy" ? `/bin/${name}` : undefined),
      spawn: () => ({ stdout: new Blob(["1.2.13\n"]).stream(), exited: Promise.resolve(0) }),
      probe: async () => "0.1.0",
    },
    { PATH: "/bin" },
  );
} else if (mode === "catalog-command") {
  await runCatalogCommand([process.execPath, "--version"], process.cwd(), {}, 5_000);
} else if (mode === "version-gate") {
  await cliVersionGate({
    provider: RUNTIME_PROVIDER.OPENCODE,
    label: "OpenCode",
    executable: "opencode",
    minimum: "0.0.1",
  }).readVersion([process.execPath]);
} else {
  throw new Error(`unknown probe: ${mode}`);
}
