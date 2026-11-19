import { readFileSync } from "node:fs";
import { join } from "node:path";

const bundle = join(import.meta.dir, "../../.output/server/index.mjs");

export function serverFunctionIds<const N extends string>(names: readonly N[]): Map<string, N> {
  const byName = new Map([...serverFunctionNames()].map(([id, name]) => [name, id]));
  const ids = new Map<string, N>();
  for (const name of names) {
    const id = byName.get(name);
    if (!id) throw new Error(`Server Function ${name} is not in ${bundle}`);
    ids.set(id, name);
  }
  return ids;
}

export function serverFunctionNames(): Map<string, string> {
  let source: string;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    throw new Error(
      `${bundle} is missing: build the Web package first (NODE_ENV=production bun run --cwd apps/web build)`,
    );
  }
  const names = new Map<string, string>();
  const pattern =
    /([A-Za-z0-9_$]+)_createServerFn_handler\s*=\s*createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})"/g;
  for (const [, name, id] of source.matchAll(pattern)) names.set(id!, name!);
  return names;
}

export function serverFunctionOf<N extends string>(ids: ReadonlyMap<string, N>, url: URL) {
  return ids.get(url.pathname.split("/_serverFn/")[1] ?? "");
}
