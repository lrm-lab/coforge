import {
  BridgeRefusal,
  INVALID_PARAMS,
  isRecord,
  requireText,
  viaHost,
  type BridgeKit,
  type CallTable,
  type PageWriteRequest,
  type Params,
} from "./artifact-page-bridge-core";
import { PAGE_BATCH_MAX, PAGE_WATCHES_MAX } from "./artifact-page-limits";

type Watch = { collection: string; query: unknown; running: boolean; again: boolean };

const WRITE_OPS = new Set(["set", "update", "delete"]);

function writeOf(op: unknown): PageWriteRequest {
  if (!isRecord(op) || typeof op.op !== "string" || !WRITE_OPS.has(op.op))
    throw new BridgeRefusal(INVALID_PARAMS, "A write expected");
  const { collection, id, data, ifVersion } = op;
  if (ifVersion !== undefined && !Number.isSafeInteger(ifVersion))
    throw new BridgeRefusal(INVALID_PARAMS, "A version expected");
  const target = {
    collection: requireText(collection, "A collection"),
    id: requireText(id, "A document id"),
    ...(ifVersion === undefined ? {} : { ifVersion: ifVersion as number }),
  };
  return op.op === "delete"
    ? { op: "delete", ...target }
    : { op: op.op as "set" | "update", ...target, data };
}

export function createDataCalls(kit: BridgeKit) {
  const watches = new Map<string, Watch>();
  let unsubscribe: (() => void) | null = null;

  const refresh = async (id: string, watch: Watch): Promise<void> => {
    if (watch.running) {
      watch.again = true;
      return;
    }
    watch.running = true;
    try {
      do {
        watch.again = false;
        try {
          const result = await kit.data.call({
            method: "query",
            collection: watch.collection,
            query: watch.query,
          });
          if (watches.get(id) === watch)
            kit.send({ method: "coforge/watch", params: { id, result } });
        } catch (cause) {
          if (watches.get(id) === watch)
            kit.send({
              method: "coforge/watch",
              params: { id, error: cause instanceof Error ? cause.message : "Failed" },
            });
        }
      } while (watch.again);
    } finally {
      watch.running = false;
    }
  };

  const changed = (collection: string) => {
    for (const [id, watch] of watches) if (watch.collection === collection) void refresh(id, watch);
  };

  const stopWhenIdle = () => {
    if (watches.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
  };

  const written = async (writes: PageWriteRequest[]) => {
    const paths = [...new Set(writes.map((write) => `${write.collection}/${write.id}`))];
    await kit.confirm("data", { kind: "data", paths }, true);
    const answer = await viaHost(kit.data.call({ method: "write", writes }));
    for (const collection of new Set(writes.map((write) => write.collection))) changed(collection);
    return answer as { results: unknown[] };
  };

  const single = (op: "set" | "update" | "delete") => async (args: Params) =>
    (await written([writeOf({ ...args, op })])).results[0];

  const calls: CallTable = {
    "db.get": async (args) =>
      (
        (await viaHost(
          kit.data.call({
            method: "get",
            collection: requireText(args.collection, "A collection"),
            id: requireText(args.id, "A document id"),
          }),
        )) as { document: unknown }
      ).document,
    "db.query": (args) =>
      viaHost(
        kit.data.call({
          method: "query",
          collection: requireText(args.collection, "A collection"),
          query: args.query,
        }),
      ),
    "db.set": single("set"),
    "db.update": single("update"),
    "db.delete": single("delete"),
    "db.batch": async (args) => {
      if (!Array.isArray(args.ops) || args.ops.length === 0 || args.ops.length > PAGE_BATCH_MAX)
        throw new BridgeRefusal(INVALID_PARAMS, `1 to ${PAGE_BATCH_MAX} writes expected`);
      return (await written(args.ops.map(writeOf))).results;
    },
    "db.watch": async (args) => {
      const id = requireText(args.id, "A watch id", 64);
      if (!watches.has(id) && watches.size >= PAGE_WATCHES_MAX)
        throw new BridgeRefusal(INVALID_PARAMS, "Too many watches");
      const watch: Watch = {
        collection: requireText(args.collection, "A collection"),
        query: args.query,
        running: false,
        again: false,
      };
      watches.set(id, watch);
      unsubscribe ??= kit.data.subscribe(changed);
      void refresh(id, watch);
      return { watching: true };
    },
    "db.unwatch": (args) => {
      watches.delete(requireText(args.id, "A watch id", 64));
      stopWhenIdle();
      return {};
    },
  };

  return {
    calls,
    dispose() {
      watches.clear();
      stopWhenIdle();
    },
  };
}
