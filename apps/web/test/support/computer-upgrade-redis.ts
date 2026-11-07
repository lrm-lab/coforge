/** The upgrade store's Redis commands in memory: string keys, the BEGIN_UPGRADE set
 * semantics and the EVAL shapes its tests pin. Shared by the store and UpgradeComputer
 * suites. */
export function computerUpgradeRedis(seed?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(seed ?? {}));
  const sets = new Map<string, Set<string>>();
  const sends: string[][] = [];
  const setsWritten: string[][] = [];
  return {
    get: async (key: string) => values.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
    set: async (...args: string[]) => {
      setsWritten.push(args);
      const [key, value, , , mode] = args;
      if (mode === "NX" && values.has(key!)) return null;
      values.set(key!, value!);
      return "OK";
    },
    send: async (command: string, args: string[]) => {
      if (command === "SMEMBERS") return [...(sets.get(args[0]!) ?? [])];
      if (command === "SREM") {
        const members = sets.get(args[0]!);
        let removed = 0;
        for (const id of args.slice(1)) if (members?.delete(id)) removed += 1;
        return removed;
      }
      sends.push(args);
      // BEGIN_UPGRADE: [script, "3", requestKey, latestKey, inflightKey, record, ttl, prefix, requestId]
      if (args[1] === "3") {
        const [, , requestKey, latestKey, inflightKey, record, ttl, prefix, requestId] = args;
        const own = values.get(requestKey!);
        if (own) return [2, own];
        const members = sets.get(inflightKey!) ?? new Set<string>();
        const dead: string[] = [];
        let active: string | undefined;
        let activeRaw: string | undefined;
        const statusOf = (raw: string | null | undefined) => {
          if (!raw) return undefined;
          try {
            return (JSON.parse(raw) as { status?: string }).status;
          } catch {
            return undefined;
          }
        };
        for (const id of members) {
          const raw = values.get(`${prefix}${id}`);
          if (statusOf(raw) === "accepted") {
            if (active === undefined) {
              active = id;
              activeRaw = raw ?? undefined;
            }
          } else dead.push(id);
        }
        const latestId = values.get(latestKey!);
        if (latestId && active === undefined && `${prefix}${latestId}` !== requestKey) {
          const raw = values.get(`${prefix}${latestId}`);
          if (statusOf(raw) === "accepted") {
            active = latestId;
            activeRaw = raw ?? undefined;
          }
        }
        for (const id of dead) members.delete(id);
        if (active !== undefined) {
          members.add(active);
          values.set(latestKey!, active);
          sets.set(inflightKey!, members);
          setsWritten.push([latestKey!, active, "EX", ttl]);
          return [0, activeRaw];
        }
        values.set(requestKey!, record!);
        members.add(requestId!);
        sets.set(inflightKey!, members);
        values.set(latestKey!, requestId!);
        setsWritten.push([requestKey!, record!, "EX", ttl], [latestKey!, requestId!, "EX", ttl]);
        return [1];
      }
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
    sets,
    sends,
    setsWritten,
  };
}
