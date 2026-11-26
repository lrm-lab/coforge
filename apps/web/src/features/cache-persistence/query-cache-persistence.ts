import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
  type AsyncStorage,
  type PersistedQuery,
} from "@tanstack/query-persist-client-core";
import { hashKey, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { z } from "zod";

import { isAppError } from "#src/lib/app-error";
import { nextTask } from "#src/lib/next-task";
import {
  isStoredData,
  persistsQuery,
  readsAfterRestore,
  storedQueryData,
  storedShapeBuster,
} from "./persisted-queries";
import { followRestoredReads } from "./restored-reads";

export type PersistedQueryStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, unknown]>>;
  clear(): Promise<void>;
};

type StoredQuery = {
  buster: string;
  queryHash: string;
  queryKey: QueryKey;
  state: { data: unknown; dataUpdatedAt: number };
};

const storedQuerySchema = z.object({
  buster: z.string(),
  queryHash: z.string(),
  queryKey: z.array(z.unknown()),
  state: z.object({
    data: z.unknown().optional(),
    dataUpdatedAt: z.number(),
  }),
});

function isReadableRow(stored: unknown): stored is StoredQuery {
  const parsed = storedQuerySchema.safeParse(stored);
  return parsed.success && isStoredData(parsed.data.queryKey, parsed.data.state.data);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECTED_AT_KEY = "meta/collected-at";

const OWNER_KEY = "meta/owner";
const STORE_WAIT_MS = 250;
const UNANSWERED_READS_LIMIT = 2;

const namespaceOf = (viewer: string) => `${encodeURIComponent(viewer)}/`;

export function installQueryCachePersistence(
  queryClient: QueryClient,
  {
    store,
    viewerId,
    maxAge = DAY_MS,
  }: {
    store: PersistedQueryStore;
    viewerId: () => string | undefined;
    maxAge?: number;
  },
) {
  let claimed: { viewer: string; done: Promise<void> } | undefined;
  const claim = (viewer: string) => {
    if (claimed?.viewer === viewer) return claimed.done;
    const namespace = namespaceOf(viewer);
    const done = store
      .set(OWNER_KEY, viewer)
      .then(() => store.keys())
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== OWNER_KEY && !key.startsWith(namespace))
            .map((key) => store.delete(key)),
        ),
      )
      .then(storeAnswered);
    claimed = { viewer, done };
    done.catch(() => {
      if (claimed?.done === done) claimed = undefined;
    });
    return done;
  };
  let sealed = false;
  let unansweredReads = 0;
  let unresponsive = false;
  const deferredWrites = new Map<string, StoredQuery | undefined>();
  function storeAnswered() {
    unansweredReads = 0;
    unresponsive = false;
    const writes = [...deferredWrites];
    deferredWrites.clear();
    for (const [key, value] of writes) void storage.setItem(key, value);
  }
  const ownNamespace = async () => {
    const viewer = viewerId();
    if (!viewer || sealed) return undefined;
    await claim(viewer);
    const owner = await store.get(OWNER_KEY);
    if (sealed || owner !== viewer) {
      sealed = true;
      return undefined;
    }
    return namespaceOf(viewer);
  };
  const keyOf = async (key: string) => {
    const namespace = await ownNamespace();
    return namespace && `${namespace}${key}`;
  };
  let lookup: { keys: string[]; rows: Promise<Map<string, StoredQuery | undefined>> } | undefined;
  const lookUp = (key: string) => {
    if (!lookup) {
      const keys: string[] = [];
      const rows = new Promise<void>((resolve) => nextTask(resolve)).then(async () => {
        lookup = undefined;
        const namespace = await ownNamespace();
        if (!namespace) return new Map<string, StoredQuery | undefined>();
        const stored = await Promise.all(keys.map((each) => store.get(`${namespace}${each}`)));
        storeAnswered();
        return new Map(keys.map((each, i) => [each, stored[i] as StoredQuery | undefined]));
      });
      lookup = { keys, rows };
    }
    lookup.keys.push(key);
    return lookup.rows.then((rows) => rows.get(key));
  };
  const answered = <T>(work: Promise<T>, miss: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        unansweredReads += 1;
        if (unansweredReads >= UNANSWERED_READS_LIMIT) unresponsive = true;
        resolve(miss);
      }, STORE_WAIT_MS);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };
  const safely = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };
  const storage: AsyncStorage<StoredQuery | undefined> = {
    getItem: (key) =>
      safely(async () => (unresponsive ? undefined : answered(lookUp(key), undefined)), undefined),
    setItem: (key, value) =>
      safely(async () => {
        if (unresponsive) {
          deferredWrites.set(key, value);
          return;
        }
        const own = await keyOf(key);
        if (!own) return;
        if (value === undefined) await store.delete(own);
        else await store.set(own, value);
      }, undefined),
    removeItem: (key) =>
      safely(async () => {
        if (unresponsive) {
          deferredWrites.set(key, undefined);
          return;
        }
        const own = await keyOf(key);
        if (own) await store.delete(own);
      }, undefined),
    entries: () =>
      safely(async () => {
        const viewer = viewerId();
        if (!viewer || !(await keyOf(""))) return [];
        const namespace = namespaceOf(viewer);
        return (await store.entries())
          .filter(([key]) => key.startsWith(namespace))
          .map(([key, value]): [string, StoredQuery | undefined] => [
            key.slice(namespace.length),
            value as StoredQuery | undefined,
          ]);
      }, []),
  };
  const toStored = (persisted: Omit<PersistedQuery, "state"> & { state: Query["state"] }) => {
    const data = storedQueryData(persisted.queryKey, persisted.state.data);
    if (data === undefined) return undefined;
    return {
      buster: persisted.buster,
      queryHash: persisted.queryHash,
      queryKey: persisted.queryKey,
      state: { data, dataUpdatedAt: persisted.state.dataUpdatedAt },
    } satisfies StoredQuery;
  };
  const persister = experimental_createQueryPersister<StoredQuery | undefined>({
    storage,
    buster: storedShapeBuster,
    maxAge,
    refetchOnRestore: false,
    filters: { predicate: (query) => persistsQuery(query.queryKey) },
    serialize: (persisted) => toStored(persisted),
    deserialize: (stored): PersistedQuery => {
      if (!isReadableRow(stored)) throw new Error("nothing readable stored");
      return {
        buster: stored.buster,
        queryHash: stored.queryHash,
        queryKey: stored.queryKey,
        state: {
          data: stored.state.data,
          dataUpdateCount: 1,
          dataUpdatedAt: stored.state.dataUpdatedAt,
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: "success",
          fetchStatus: "idle",
        },
      };
    },
  });
  const restoredReads = followRestoredReads(queryClient);
  const persisterFn: typeof persister.persisterFn = async (queryFn, context, query) => {
    const restoring = query.state.data === undefined;
    let networkRead = false;
    const data = await persister.persisterFn(
      (readContext) => {
        networkRead = true;
        return queryFn(readContext);
      },
      context,
      query,
    );
    if (restoring && !networkRead && readsAfterRestore(query.queryKey))
      restoredReads.restored(query);
    return data;
  };
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    if (!persistsQuery(event.query.queryKey)) return;
    if (!isAppError(event.action.error) || event.action.error.code !== "NOT_FOUND") return;
    void storage.removeItem(`${PERSISTER_KEY_PREFIX}-${event.query.queryHash}`);
  });
  const storeNow = (queryHash: string) => {
    const query = queryClient.getQueryCache().get(queryHash);
    if (!query || query.state.status !== "success" || query.state.isInvalidated) return;
    const stored = toStored({
      buster: storedShapeBuster,
      queryHash,
      queryKey: query.queryKey,
      state: query.state,
    });
    if (!stored) return;
    return storage.setItem(`${PERSISTER_KEY_PREFIX}-${queryHash}`, stored);
  };
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: {
      ...defaults.queries,
      persister: persisterFn,
      networkMode: defaults.queries?.networkMode ?? "online",
    },
  });
  return {
    restoredCopyShown: (queryKey: QueryKey) => restoredReads.awaiting(hashKey(queryKey)),
    restoredCopyReplaced: (queryKey: QueryKey) => {
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      if (query) restoredReads.replaced(query);
    },
    subscribeRestoredReads: restoredReads.subscribe,
    async seed() {
      await safely(async () => {
        const held = queryClient.getQueryCache().findAll({
          predicate: (query) => query.state.status === "success" && persistsQuery(query.queryKey),
        });
        await Promise.all(held.map((query) => persister.persistQuery(query)));
      }, undefined);
    },
    async collectGarbage() {
      await safely(async () => {
        const marker = await keyOf(COLLECTED_AT_KEY);
        if (!marker) return;
        const last = await store.get(marker);
        if (typeof last === "number" && Date.now() - last < DAY_MS) return;
        await persister.persisterGc();
        await store.set(marker, Date.now());
      }, undefined);
    },
    async store(queryKey: QueryKey) {
      if (!persistsQuery(queryKey)) return;
      await storeNow(hashKey(queryKey));
    },
    async purge() {
      sealed = true;
      await store.clear();
    },
  };
}
