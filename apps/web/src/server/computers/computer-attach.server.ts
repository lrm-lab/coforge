import type { PrismaClient } from "#src/generated/prisma/client";
import { mintOpaqueToken, sha256Hex } from "#src/server/auth/opaque-token.server";
import { verifyComputerAccessToken } from "#src/server/auth/computer-access-token.server";

const audit = (detail: Record<string, unknown>) =>
  console.info(JSON.stringify({ event: "computer_attach", ...detail }));

/**
 * The one-shot Computer attach (task #417): the machine reports itself, a person approves on
 * the approval page, the deviceCode polls for a single-use attachToken, and the existing
 * `computer:register` consumes it for an `sk_computer`. Codes and the token reach the Computer
 * once and live only as hashes here; `computerId` never comes from a request.
 */

const ATTACH_SESSION_TTL_MS = 10 * 60 * 1000;
const ATTACH_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A poll faster than this answers `slow_down`, as the OAuth device flow's does. */
const POLL_INTERVAL_MS = 3 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type AttachPollResult =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "token"; attachToken: string; expiresInSeconds: number };

const mintDeviceCode = () => `cd_${mintOpaqueToken()}`;
const mintAttachToken = () => `at_${mintOpaqueToken()}`;
const hash = sha256Hex;

function mintUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]!).join("");
}

/**
 * `attach/start`: a machine asks to be attached, reporting itself. Answers the deviceCode it
 * will poll with (a bearer secret, never in a link), the short userCode a person compares on
 * the approval page, and the approval URL — which carries only the session id, so a link a
 * stranger clicked cannot approve it: they would see the page but not the code the CLI shows.
 */
export async function startAttachSession(
  db: Pick<PrismaClient, "computerAttachSession">,
  input: { machineName: string; hostname: string; os: string; origin: string },
  now: Date = new Date(),
): Promise<{
  sessionId: string;
  deviceCode: string;
  userCode: string;
  approveUrl: string;
  expiresInSeconds: number;
}> {
  const deviceCode = mintDeviceCode();
  const userCode = mintUserCode();
  const expiresAt = new Date(now.getTime() + ATTACH_SESSION_TTL_MS);
  const session = await db.computerAttachSession.create({
    data: {
      deviceCodeHash: hash(deviceCode),
      userCode,
      machineName: input.machineName,
      hostname: input.hostname,
      os: input.os,
      expiresAt,
    },
    select: { id: true },
  });
  audit({ action: "attach_start", session_id: session.id });
  return {
    sessionId: session.id,
    deviceCode,
    userCode,
    approveUrl: `${input.origin}/computers/attach/${session.id}`,
    expiresInSeconds: ATTACH_SESSION_TTL_MS / 1000,
  };
}

/**
 * `attach/poll`: the machine trades its deviceCode for the one-shot attachToken. Answers the
 * OAuth device flow's statuses: `attach_pending`, `slow_down` under the interval,
 * `expired_token` past the session's life, `access_denied` where the person refused.
 * On approval the poll mints the token once and answers it; the hash it keeps is the only
 * copy, so a poll cannot replay a token it already handed out.
 */
export async function pollAttachSession(
  db: Pick<PrismaClient, "computerAttachSession"> & Pick<PrismaClient, "$transaction">,
  input: { deviceCode: string },
  now: Date = new Date(),
): Promise<AttachPollResult> {
  return db.$transaction(async (tx) => {
    const [session] = await tx.$queryRaw<
      {
        id: string;
        status: string;
        attachTokenHash: string | null;
        expiresAt: Date;
        lastPolledAt: Date | null;
      }[]
    >`SELECT "id", "status", "attach_token_hash" AS "attachTokenHash", "expires_at" AS "expiresAt",
             "last_polled_at" AS "lastPolledAt"
        FROM "computer_attach_sessions"
        WHERE "device_code_hash" = ${hash(input.deviceCode)}
        FOR UPDATE`;
    // A swept or never-known deviceCode answers the same expiry as one that ran out.
    if (!session) return { kind: "expired" };
    if (session.status === "refused") return { kind: "denied" };
    if (session.expiresAt.getTime() < now.getTime()) {
      if (session.status !== "expired")
        await tx.computerAttachSession.update({
          where: { id: session.id },
          data: { status: "expired" },
        });
      return { kind: "expired" };
    }
    if (session.lastPolledAt && now.getTime() - session.lastPolledAt.getTime() < POLL_INTERVAL_MS)
      return { kind: "slow_down" };
    await tx.computerAttachSession.update({
      where: { id: session.id },
      data: { lastPolledAt: now },
    });
    if (session.status !== "approved") return { kind: "pending" };
    if (session.attachTokenHash) return { kind: "pending" };
    const attachToken = mintAttachToken();
    const tokenExpiresAt = new Date(now.getTime() + ATTACH_TOKEN_TTL_MS);
    await tx.computerAttachSession.update({
      where: { id: session.id },
      data: { attachTokenHash: hash(attachToken), attachTokenExpiresAt: tokenExpiresAt },
    });
    return {
      kind: "token",
      attachToken,
      expiresInSeconds: Math.round((tokenExpiresAt.getTime() - now.getTime()) / 1000),
    };
  });
}

/**
 * The principal a `Bearer at_…` resolves to — read only, never consuming. Consumption is the
 * register path's to make inside its own transaction (task #417): a token an authenticate step
 * merely looked at stays usable for the register that is about to run, and `workspace.get`
 * never burns one. `attachSessionId` marks the principal so a path that must not see a token
 * (workspace.get) refuses it outright.
 */
export async function resolveAttachToken(
  db: Pick<PrismaClient, "computerAttachSession">,
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string; workspaceId: string; sessionId: string } | null> {
  const session = await db.computerAttachSession.findUnique({
    where: { attachTokenHash: hash(token) },
    select: {
      id: true,
      status: true,
      approvedUserId: true,
      approvedWorkspaceId: true,
      attachTokenExpiresAt: true,
      tokenConsumedAt: true,
    },
  });
  if (
    !session ||
    session.status !== "approved" ||
    session.tokenConsumedAt ||
    !session.attachTokenExpiresAt ||
    session.attachTokenExpiresAt.getTime() < now.getTime() ||
    !session.approvedUserId ||
    !session.approvedWorkspaceId
  )
    return null;
  return {
    userId: session.approvedUserId,
    workspaceId: session.approvedWorkspaceId,
    sessionId: session.id,
  };
}

/**
 * The register path's consumption — inside its own transaction, so a token and the
 * `sk_computer` it buys change hands atomically: a racing second register finds it gone and a
 * refused register leaves it usable. The token is bound to its session's approving user and
 * chosen workspace; it is single-use.
 */
export async function consumeAttachToken(
  tx: Pick<PrismaClient, "computerAttachSession">,
  sessionId: string,
  now: Date = new Date(),
): Promise<{ userId: string; workspaceId: string } | null> {
  const result = await tx.computerAttachSession.updateMany({
    where: {
      id: sessionId,
      status: "approved",
      tokenConsumedAt: null,
      attachTokenExpiresAt: { gt: now },
    },
    data: { tokenConsumedAt: now, status: "consumed" },
  });
  if (result.count !== 1) return null;
  const session = await tx.computerAttachSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { approvedUserId: true, approvedWorkspaceId: true },
  });
  return {
    userId: session.approvedUserId!,
    workspaceId: session.approvedWorkspaceId!,
  };
}

/**
 * The approval page's read: the machine's reported name, host and OS, plus its userCode —
 * the person compares it with the CLI's before they approve. A session is shown only to a
 * signed-in approver and only while it is still pending.
 */
export async function readAttachSession(
  db: Pick<PrismaClient, "computerAttachSession">,
  sessionId: string,
  now: Date = new Date(),
): Promise<{
  machineName: string;
  hostname: string;
  os: string;
  userCode: string;
  status: string;
} | null> {
  const session = await db.computerAttachSession.findUnique({
    where: { id: sessionId },
    select: {
      machineName: true,
      hostname: true,
      os: true,
      userCode: true,
      status: true,
      expiresAt: true,
    },
  });
  if (!session || session.status !== "pending" || session.expiresAt.getTime() < now.getTime())
    return null;
  return session;
}

/** Approve a pending attach for the workspace the approver picked; the workspace's attachable
 * set is the caller's to have checked. */
export async function approveAttachSession(
  db: Pick<PrismaClient, "computerAttachSession">,
  input: { sessionId: string; userId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db.computerAttachSession.updateMany({
    where: {
      id: input.sessionId,
      status: "pending",
      expiresAt: { gt: now },
    },
    data: {
      status: "approved",
      approvedUserId: input.userId,
      approvedWorkspaceId: input.workspaceId,
    },
  });
  if (result.count === 1)
    audit({
      action: "attach_approved",
      session_id: input.sessionId,
      user_id: input.userId,
      workspace_id: input.workspaceId,
    });
  return result.count === 1;
}

/** Refuse a pending attach; the computer's next poll hears `access_denied`. */
export async function refuseAttachSession(
  db: Pick<PrismaClient, "computerAttachSession">,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db.computerAttachSession.updateMany({
    where: { id: sessionId, status: "pending", expiresAt: { gt: now } },
    data: { status: "refused" },
  });
  if (result.count === 1) audit({ action: "attach_refused", session_id: sessionId });
  return result.count === 1;
}

/**
 * The `computer:register` authenticate seam (task #417): a `Bearer at_…` attach token resolves
 * to the user and workspace its approval bound — the token, not the body's `workspaceSlug`,
 * decides where the machine lands. Anything else falls through to the ordinary login JWT,
 * refused where that login was retired.
 */
export async function authenticateComputerAttach(
  request: Request,
  db: Pick<PrismaClient, "computerAttachSession" | "computerRetiredLogin"> &
    Pick<PrismaClient, "$transaction">,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ userId: string; workspaceId?: string; attachSessionId?: string } | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const bearer = header.slice(7).trim();
  if (bearer.startsWith("at_")) {
    // Resolve only — the token is consumed inside the register path's own transaction, so a
    // `workspace.get` looking at it or a refused register leaves it usable (task #417).
    const principal = await resolveAttachToken(db, bearer);
    return principal
      ? {
          userId: principal.userId,
          workspaceId: principal.workspaceId,
          attachSessionId: principal.sessionId,
        }
      : null;
  }
  const principal = await verifyComputerAccessToken(bearer, environment);
  if (!principal) return null;
  if (await db.computerRetiredLogin.findUnique({ where: { tokenHash: sha256Hex(bearer) } }))
    return null;
  return principal;
}

/**
 * `retire-session` (task #417): a Computer retires the login its setup left behind — the
 * `Authorization` bearer is that login (a Computer access token, the device flow's kind), and
 * the Computer's own `sk_computer` names the machine in `x-coforge-computer-key`. Only the
 * device login that setup left retires — its own kind (`session_not_device` for a browser
 * login), its own user (another person's or a stranger's login never is). Idempotent: a retired token answers `already_retired`.
 */
export async function retireComputerSession(
  db: Pick<PrismaClient, "computerRetiredLogin">,
  input: {
    /** The login being retired — the Bearer the Computer presents. */
    userToken: string;
    /** The claims the Computer's own key verified to (already authenticated). */
    principal: { userId: string; workspaceId: string; computerId: string };
  },
  environment: Record<string, string | undefined> = process.env,
): Promise<
  { kind: "retired" | "already_retired" } | { kind: "session_not_device" } | { kind: "wrong_owner" }
> {
  const login = await verifyComputerAccessToken(input.userToken, environment);
  // Only the device login this endpoint retires: a token the device flow minted carries
  // `kind: "device"`; a browser login — verified by the same key but without it — is refused.
  if (!login || login.kind !== "device") return { kind: "session_not_device" };
  // The token's user must own the computer key the request authenticated with; the login's own
  // claims, not a name the caller supplies, decide.
  if (login.userId !== input.principal.userId) return { kind: "wrong_owner" };
  // Create-or-already: two concurrent retire calls race to one row rather than one of them
  // answering a unique-constraint 500; the second reads `already_retired` either way.
  const tokenHash = sha256Hex(input.userToken);
  try {
    await db.computerRetiredLogin.create({
      data: {
        tokenHash,
        userId: login.userId,
        computerId: input.principal.computerId,
        workspaceId: input.principal.workspaceId,
      },
    });
    audit({
      action: "login_retired",
      user_id: login.userId,
      computer_id: input.principal.computerId,
    });
    return { kind: "retired" };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { kind: "already_retired" };
    throw error;
  }
}
