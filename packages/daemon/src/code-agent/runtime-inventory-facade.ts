import type { CodeAgentDiscoveryOptions } from "./discovery-options";
import {
  discoverCodeAgentCatalogs,
  discoverCodeAgentRuntimes,
  type CodeAgentInventory,
} from "./runtime-inventory";

export async function discoverCodeAgentInventory(
  options: CodeAgentDiscoveryOptions,
): Promise<CodeAgentInventory> {
  const runtimes = await discoverCodeAgentRuntimes(options);
  const { catalogs } = await discoverCodeAgentCatalogs(runtimes, options);
  return { runtimes, catalogs };
}
