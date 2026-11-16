import { createMemoryDispositionTool } from "./memory-disposition-tool";
import { createPlatformMemoryTool, platformMemoryEnabled } from "./platform-memory-tool";

export function createTaskMemoryTools(
  fence: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  proxy: { post(path: string, body: unknown): Promise<unknown> },
) {
  if (fence) return [];
  return [
    createMemoryDispositionTool(proxy),
    ...(platformMemoryEnabled(environment) ? [createPlatformMemoryTool(proxy)] : []),
  ];
}
