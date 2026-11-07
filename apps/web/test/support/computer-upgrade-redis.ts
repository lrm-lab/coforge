/** The upgrade store's Redis commands in memory, shared by the store and UpgradeComputer
 * suites. */
export function computerUpgradeRedis(seed?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(seed ?? {}));
  const sends: string[][] = [];
  const sets: string[][] = [];
  return {
    get: async (key: string) => values.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
    set: async (...args: string[]) => {
      sets.push(args);
      const [key, value, , , mode] = args;
      if (mode === "NX" && values.has(key!)) return null;
      values.set(key!, value!);
      return "OK";
    },
    send: async (_command: "EVAL", args: string[]) => {
      sends.push(args);
      if (args.length === 4) {
        const [, , key, candidate] = args;
        const current = values.get(key!);
        if (!current || JSON.parse(current).startedAt <= JSON.parse(candidate!).startedAt)
          values.set(key!, candidate!);
        return 1;
      }
      if (args[1] === "2") {
        const [, , requestKey, identityKey, expected, identity, value] = args;
        if (values.get(requestKey!) !== expected) return 0;
        values.set(identityKey!, identity!);
        values.set(requestKey!, value!);
        return 1;
      }
      const [, , key, expected, value] = args;
      if (values.get(key!) !== expected) return 0;
      values.set(key!, value!);
      return 1;
    },
    values,
    sends,
    sets,
  };
}
