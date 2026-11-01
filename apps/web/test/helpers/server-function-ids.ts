import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This build's Server Function ids, by id, for the export names given. The id on the wire is the
 * hash the build gave the function - it does not encode the name, so it cannot be decoded back
 * out of the URL. The artifact the local Web is serving states the pairing, one line per function:
 * `NAME_createServerFn_handler = createServerRpc({ id: "<64 hex>" ...`. A name the build lacks
 * throws: an e2e that means to recognise a read must fail loudly if it cannot
 * (docs/agents/testing.md).
 */
export function serverFunctionIds<const N extends string>(names: readonly N[]): Map<string, N> {
  const bundle = join(import.meta.dir, "../../.output/server/index.mjs");
  let source: string;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    throw new Error(
      `${bundle} is missing: build the Web package first (NODE_ENV=production bun run --cwd apps/web build)`,
    );
  }
  const byName = new Map<string, string>();
  const pattern =
    /([A-Za-z0-9_$]+)_createServerFn_handler\s*=\s*createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})"/g;
  for (const [, name, id] of source.matchAll(pattern)) byName.set(name!, id!);
  const ids = new Map<string, N>();
  for (const name of names) {
    const id = byName.get(name);
    if (!id) throw new Error(`Server Function ${name} is not in ${bundle}`);
    ids.set(id, name);
  }
  return ids;
}

/** The Server Function a request calls, by its export name among `ids`, if any. */
export function serverFunctionOf<N extends string>(ids: ReadonlyMap<string, N>, url: URL) {
  return ids.get(url.pathname.split("/_serverFn/")[1] ?? "");
}
