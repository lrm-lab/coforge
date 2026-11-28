import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

export const TERMINAL_ATTACHED_TTL_SECONDS = 35 * 60;
export const TERMINAL_DETACHED_TTL_SECONDS = 30 * 60;

export type TerminalScopeKey = {
  workspaceId: string;
  computerId: string;
};

export type TerminalAttachMode = "interactive" | "readonly";

export type TerminalAttachRecord = {
  attachId: string;
  attachGeneration: number;
  loginGeneration: number;
  mode: TerminalAttachMode;
  nextInputSeq: number;
  cols: number;
  rows: number;
  opened: boolean;
  createdAtMs: number;
};

export type TerminalSessionRecord = {
  workspaceId: string;
  computerId: string;
  ownerUserId: string;
  sessionId: string;
  daemonInstanceId: string;
  attachGeneration: number;
  cols: number;
  rows: number;
  activeAttach: TerminalAttachRecord | null;
  updatedAtMs: number;
};

export type ExpectedTerminalAttach = {
  sessionId: string;
  attachId: string;
  attachGeneration: number;
};

export type AdvanceInputSeqResult =
  | { outcome: "accepted"; nextInputSeq: number }
  | { outcome: "duplicate"; nextInputSeq: number }
  | { outcome: "sequence_mismatch"; expectedInputSeq: number }
  | { outcome: "invalid_attach" };

export interface ComputerTerminalStore {
  getSession(scope: TerminalScopeKey): Promise<TerminalSessionRecord | undefined>;
  saveSession(session: TerminalSessionRecord): Promise<void>;
  markOpened(scope: TerminalScopeKey, expected: ExpectedTerminalAttach): Promise<boolean>;
  updateDimensions(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    cols: number,
    rows: number,
  ): Promise<boolean>;
  advanceInputSeq(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    inputSeq: number,
  ): Promise<AdvanceInputSeqResult>;
  detachAttach(
    scope: TerminalScopeKey,
    expected?: ExpectedTerminalAttach,
  ): Promise<TerminalSessionRecord | undefined>;
  clearSession(
    scope: TerminalScopeKey,
    expectedSessionId?: string,
  ): Promise<TerminalSessionRecord | undefined>;
  listUserAttachments(userId: string): Promise<TerminalSessionRecord[]>;
}

const MARK_OPENED_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= "table" then return 0 end
if session.sessionId ~= ARGV[1] then return 0 end
local attach = session.activeAttach
if type(attach) ~= "table" or attach == cjson.null then return 0 end
if attach.attachId ~= ARGV[2] or attach.attachGeneration ~= tonumber(ARGV[3]) then return 0 end
attach.opened = true
session.updatedAtMs = tonumber(ARGV[4])
redis.call("SET", KEYS[1], cjson.encode(session), "EX", ARGV[5])
return 1`;

const UPDATE_DIMENSIONS_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= "table" then return 0 end
if session.sessionId ~= ARGV[1] then return 0 end
local attach = session.activeAttach
if type(attach) ~= "table" or attach == cjson.null then return 0 end
if attach.attachId ~= ARGV[2] or attach.attachGeneration ~= tonumber(ARGV[3]) then return 0 end
local cols = tonumber(ARGV[4])
local rows = tonumber(ARGV[5])
session.cols = cols
session.rows = rows
attach.cols = cols
attach.rows = rows
session.updatedAtMs = tonumber(ARGV[6])
redis.call("SET", KEYS[1], cjson.encode(session), "EX", ARGV[7])
return 1`;

const ADVANCE_INPUT_SEQ_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return {"invalid_attach", 0} end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= "table" then return {"invalid_attach", 0} end
if session.sessionId ~= ARGV[1] then return {"invalid_attach", 0} end
local attach = session.activeAttach
if type(attach) ~= "table" or attach == cjson.null then return {"invalid_attach", 0} end
if attach.attachId ~= ARGV[2] or attach.attachGeneration ~= tonumber(ARGV[3]) then
  return {"invalid_attach", 0}
end
if attach.mode ~= "interactive" then return {"invalid_attach", 0} end
local seq = tonumber(ARGV[4])
local expected = tonumber(attach.nextInputSeq)
if seq < expected then
  return {"duplicate", expected}
end
if seq > expected then
  return {"sequence_mismatch", expected}
end
local nextSeq = expected + 1
attach.nextInputSeq = nextSeq
session.updatedAtMs = tonumber(ARGV[5])
redis.call("SET", KEYS[1], cjson.encode(session), "EX", ARGV[6])
return {"accepted", nextSeq}`;

const DETACH_ATTACH_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= "table" then return nil end
local attach = session.activeAttach
if type(attach) ~= "table" or attach == cjson.null then return nil end
if ARGV[1] ~= "" then
  if session.sessionId ~= ARGV[1] or attach.attachId ~= ARGV[2] or attach.attachGeneration ~= tonumber(ARGV[3]) then
    return nil
  end
end
session.activeAttach = cjson.null
session.updatedAtMs = tonumber(ARGV[4])
redis.call("SET", KEYS[1], cjson.encode(session), "EX", ARGV[5])
redis.call("SREM", KEYS[2], ARGV[6])
return raw`;

const CLEAR_SESSION_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= "table" then
  redis.call("DEL", KEYS[1])
  return nil
end
if ARGV[1] ~= "" and session.sessionId ~= ARGV[1] then
  return nil
end
redis.call("DEL", KEYS[1])
redis.call("SREM", KEYS[2], ARGV[2])
return raw`;

function sessionKey(scope: TerminalScopeKey): string {
  return workspaceRedisKey({
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    name: "computer-terminal",
    version: "v1",
  });
}

function userAttachesKey(userId: string): string {
  return `coforge:user:${encodeURIComponent(userId)}:terminal-attaches:v1`;
}

function userMemberKey(scope: TerminalScopeKey): string {
  return `${scope.workspaceId}|${scope.computerId}`;
}

function parseUserMemberKey(member: string): TerminalScopeKey | undefined {
  const separator = member.indexOf("|");
  if (separator <= 0 || separator === member.length - 1) return undefined;
  return {
    workspaceId: member.slice(0, separator),
    computerId: member.slice(separator + 1),
  };
}

function parseSession(raw: string | null): TerminalSessionRecord | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalSessionRecord>;
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.computerId !== "string" ||
      typeof parsed.ownerUserId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.daemonInstanceId !== "string" ||
      typeof parsed.attachGeneration !== "number"
    ) {
      return undefined;
    }
    return {
      workspaceId: parsed.workspaceId,
      computerId: parsed.computerId,
      ownerUserId: parsed.ownerUserId,
      sessionId: parsed.sessionId,
      daemonInstanceId: parsed.daemonInstanceId,
      attachGeneration: parsed.attachGeneration,
      cols: typeof parsed.cols === "number" ? parsed.cols : (parsed.activeAttach?.cols ?? 80),
      rows: typeof parsed.rows === "number" ? parsed.rows : (parsed.activeAttach?.rows ?? 24),
      activeAttach: parsed.activeAttach ?? null,
      updatedAtMs: typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
    };
  } catch {
    return undefined;
  }
}

export class RedisComputerTerminalStore implements ComputerTerminalStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      send(command: string, args: string[]): Promise<unknown>;
    },
    private readonly now: () => number = Date.now,
  ) {}

  async getSession(scope: TerminalScopeKey): Promise<TerminalSessionRecord | undefined> {
    return parseSession(await this.redis.get(sessionKey(scope)));
  }

  async saveSession(session: TerminalSessionRecord): Promise<void> {
    const ttl = session.activeAttach
      ? TERMINAL_ATTACHED_TTL_SECONDS
      : TERMINAL_DETACHED_TTL_SECONDS;
    const key = sessionKey(session);
    const userKey = userAttachesKey(session.ownerUserId);
    const member = userMemberKey(session);
    await this.redis.set(key, JSON.stringify(session), "EX", String(ttl));
    if (session.activeAttach) {
      await this.redis.send("SADD", [userKey, member]);
      await this.redis.send("EXPIRE", [userKey, String(TERMINAL_ATTACHED_TTL_SECONDS)]);
    } else {
      await this.redis.send("SREM", [userKey, member]);
    }
  }

  async markOpened(scope: TerminalScopeKey, expected: ExpectedTerminalAttach): Promise<boolean> {
    const result = await this.redis.send("EVAL", [
      MARK_OPENED_LUA,
      "1",
      sessionKey(scope),
      expected.sessionId,
      expected.attachId,
      String(expected.attachGeneration),
      String(this.now()),
      String(TERMINAL_ATTACHED_TTL_SECONDS),
    ]);
    return result === 1;
  }

  async updateDimensions(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    const result = await this.redis.send("EVAL", [
      UPDATE_DIMENSIONS_LUA,
      "1",
      sessionKey(scope),
      expected.sessionId,
      expected.attachId,
      String(expected.attachGeneration),
      String(cols),
      String(rows),
      String(this.now()),
      String(TERMINAL_ATTACHED_TTL_SECONDS),
    ]);
    return result === 1;
  }

  async advanceInputSeq(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    inputSeq: number,
  ): Promise<AdvanceInputSeqResult> {
    const result = await this.redis.send("EVAL", [
      ADVANCE_INPUT_SEQ_LUA,
      "1",
      sessionKey(scope),
      expected.sessionId,
      expected.attachId,
      String(expected.attachGeneration),
      String(inputSeq),
      String(this.now()),
      String(TERMINAL_ATTACHED_TTL_SECONDS),
    ]);
    if (!Array.isArray(result)) return { outcome: "invalid_attach" };
    const status = result[0];
    const seq = Number(result[1]);
    if (status === "accepted") return { outcome: "accepted", nextInputSeq: seq };
    if (status === "duplicate") return { outcome: "duplicate", nextInputSeq: seq };
    if (status === "sequence_mismatch")
      return { outcome: "sequence_mismatch", expectedInputSeq: seq };
    return { outcome: "invalid_attach" };
  }

  async detachAttach(
    scope: TerminalScopeKey,
    expected?: ExpectedTerminalAttach,
  ): Promise<TerminalSessionRecord | undefined> {
    const current = await this.getSession(scope);
    if (!current || !current.activeAttach) return undefined;
    const raw = await this.redis.send("EVAL", [
      DETACH_ATTACH_LUA,
      "2",
      sessionKey(scope),
      userAttachesKey(current.ownerUserId),
      expected?.sessionId ?? "",
      expected?.attachId ?? "",
      String(expected?.attachGeneration ?? 0),
      String(this.now()),
      String(TERMINAL_DETACHED_TTL_SECONDS),
      userMemberKey(scope),
    ]);
    return typeof raw === "string" ? parseSession(raw) : undefined;
  }

  async clearSession(
    scope: TerminalScopeKey,
    expectedSessionId?: string,
  ): Promise<TerminalSessionRecord | undefined> {
    const current = await this.getSession(scope);
    if (!current) return undefined;
    const raw = await this.redis.send("EVAL", [
      CLEAR_SESSION_LUA,
      "2",
      sessionKey(scope),
      userAttachesKey(current.ownerUserId),
      expectedSessionId ?? "",
      userMemberKey(scope),
    ]);
    return typeof raw === "string" ? parseSession(raw) : undefined;
  }

  async listUserAttachments(userId: string): Promise<TerminalSessionRecord[]> {
    const userKey = userAttachesKey(userId);
    const members = await this.redis.send("SMEMBERS", [userKey]);
    if (!Array.isArray(members)) return [];
    const results: TerminalSessionRecord[] = [];
    for (const member of members) {
      if (typeof member !== "string") continue;
      const scope = parseUserMemberKey(member);
      if (!scope) {
        await this.redis.send("SREM", [userKey, member]);
        continue;
      }
      const session = await this.getSession(scope);
      if (!session || session.ownerUserId !== userId || !session.activeAttach) {
        await this.redis.send("SREM", [userKey, member]);
        continue;
      }
      results.push(session);
    }
    return results;
  }
}

export class InMemoryComputerTerminalStore implements ComputerTerminalStore {
  private readonly sessions = new Map<
    string,
    { value: TerminalSessionRecord; expiresAtMs: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async getSession(scope: TerminalScopeKey): Promise<TerminalSessionRecord | undefined> {
    const key = sessionKey(scope);
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      this.sessions.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  async saveSession(session: TerminalSessionRecord): Promise<void> {
    const ttlSeconds = session.activeAttach
      ? TERMINAL_ATTACHED_TTL_SECONDS
      : TERMINAL_DETACHED_TTL_SECONDS;
    this.sessions.set(sessionKey(session), {
      value: structuredClone(session),
      expiresAtMs: this.now() + ttlSeconds * 1000,
    });
  }

  async markOpened(scope: TerminalScopeKey, expected: ExpectedTerminalAttach): Promise<boolean> {
    const session = await this.getSession(scope);
    if (!session || !matchesAttach(session, expected)) return false;
    session.activeAttach!.opened = true;
    session.updatedAtMs = this.now();
    await this.saveSession(session);
    return true;
  }

  async updateDimensions(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    const session = await this.getSession(scope);
    if (!session || !matchesAttach(session, expected)) return false;
    session.cols = cols;
    session.rows = rows;
    session.activeAttach!.cols = cols;
    session.activeAttach!.rows = rows;
    session.updatedAtMs = this.now();
    await this.saveSession(session);
    return true;
  }

  async advanceInputSeq(
    scope: TerminalScopeKey,
    expected: ExpectedTerminalAttach,
    inputSeq: number,
  ): Promise<AdvanceInputSeqResult> {
    const session = await this.getSession(scope);
    if (
      !session ||
      !matchesAttach(session, expected) ||
      session.activeAttach!.mode !== "interactive"
    ) {
      return { outcome: "invalid_attach" };
    }
    const currentSeq = session.activeAttach!.nextInputSeq;
    if (inputSeq < currentSeq) return { outcome: "duplicate", nextInputSeq: currentSeq };
    if (inputSeq > currentSeq)
      return { outcome: "sequence_mismatch", expectedInputSeq: currentSeq };
    session.activeAttach!.nextInputSeq = currentSeq + 1;
    session.updatedAtMs = this.now();
    await this.saveSession(session);
    return { outcome: "accepted", nextInputSeq: currentSeq + 1 };
  }

  async detachAttach(
    scope: TerminalScopeKey,
    expected?: ExpectedTerminalAttach,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = await this.getSession(scope);
    if (!session || !session.activeAttach) return undefined;
    if (expected && !matchesAttach(session, expected)) return undefined;
    const previous = structuredClone(session);
    session.activeAttach = null;
    session.updatedAtMs = this.now();
    await this.saveSession(session);
    return previous;
  }

  async clearSession(
    scope: TerminalScopeKey,
    expectedSessionId?: string,
  ): Promise<TerminalSessionRecord | undefined> {
    const session = await this.getSession(scope);
    if (!session) return undefined;
    if (expectedSessionId && session.sessionId !== expectedSessionId) return undefined;
    this.sessions.delete(sessionKey(scope));
    return session;
  }

  async listUserAttachments(userId: string): Promise<TerminalSessionRecord[]> {
    const nowMs = this.now();
    const active: TerminalSessionRecord[] = [];
    for (const [key, entry] of this.sessions) {
      if (entry.expiresAtMs <= nowMs) {
        this.sessions.delete(key);
        continue;
      }
      if (entry.value.ownerUserId === userId && entry.value.activeAttach) {
        active.push(structuredClone(entry.value));
      }
    }
    return active;
  }
}

function matchesAttach(session: TerminalSessionRecord, expected: ExpectedTerminalAttach): boolean {
  return (
    session.sessionId === expected.sessionId &&
    session.activeAttach !== null &&
    session.activeAttach.attachId === expected.attachId &&
    session.activeAttach.attachGeneration === expected.attachGeneration
  );
}

let singleton: ComputerTerminalStore | undefined;

export function getComputerTerminalStore(): ComputerTerminalStore {
  return (singleton ??= new RedisComputerTerminalStore(
    openRedisClient(redisUrlFor("Computer terminal sessions")),
  ));
}
