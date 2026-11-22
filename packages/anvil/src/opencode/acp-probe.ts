import { acpProcess } from "#src/acp/connection";
import { within } from "#src/catalog-discovery";
import type { OpenCodeAcpRuntimeHost } from "./acp-host";
import { OPENCODE_ACP_PROFILE } from "./acp-session";
import { runOpenCodeStartup } from "./startup";

export async function openOpenCodeProbe(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: OpenCodeAcpRuntimeHost,
  timeoutMs: number,
  onStderr: (line: string) => void,
  signal?: AbortSignal,
) {
  const childEnvironment = { ...environment, PWD: cwd };
  return runOpenCodeStartup(
    cwd,
    childEnvironment,
    timeoutMs,
    async (track) => {
      const transport = acpProcess(OPENCODE_ACP_PROFILE, {
        command,
        cwd,
        environment: childEnvironment,
        clientInfo: host.clientInfo,
        processTreeSpawner: host.processTreeSpawner,
        onStderr,
      });
      track(transport.process);
      let disposal: Promise<void> | undefined;
      const abort = () => {
        disposal ??= transport.dispose();
        void disposal.catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await transport.initialize(timeoutMs);
        const session = await within(
          transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
          timeoutMs,
        );
        signal?.throwIfAborted();
        return { transport, session };
      } catch (error) {
        await (disposal ?? transport.dispose());
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    signal,
  );
}
