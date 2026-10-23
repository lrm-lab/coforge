import type { Prisma } from "#src/generated/prisma/client";
import { APP_BOT_KIND, isAppBot } from "#src/features/agents/agent-system-kind";
import { AppError } from "#src/lib/app-error";

/**
 * An `Agent` row that has not been deleted. `deletedAt` is the delete marker: an
 * Agent row can never be hard-deleted once it owns a Message, Task or Action card
 * (`Message.sender`, `Task.creator`/`owner` and `ActionCard.preparedByAgent` are
 * `onDelete: Restrict`), so "is this Agent currently live" must always be spelled with this
 * filter rather than by row existence alone — the same shape `ACTIVE_MEMBER_WHERE` already
 * established for channel membership.
 *
 * A deleted Agent keeps its Messages and Tasks so history stays readable, but is hidden from
 * every directory, list, wake, control and profile lookup, and can never mint another Agent API
 * key. Read the raw row (without this filter) only from the deletion module itself and from the
 * message projections that render a deleted sender.
 */
export const ACTIVE_AGENT_WHERE = { deletedAt: null } satisfies Prisma.AgentWhereInput;
// Raw SQL spells the same rule as `"deletedAt" IS NULL` (`viewerDirectConversationSql` and the
// Activity inbox laterals); change those with it.

/**
 * Refuse a mutation aimed at a deleted Agent. The filter above hides a deleted Agent
 * from live *reads*; this is the matching guard for *writes* and control, which must resolve the
 * raw row first (recovery has to observe a deleted Agent to reconcile a process the Daemon still
 * reports as running). One owner of the refusal keeps the answer consistent: every caller that
 * reaches one by id answers the same `NOT_FOUND` a live-view lookup would, instead of leaking a
 * generic 500 or an authorization-shaped error.
 *
 * Callers are the paths that could otherwise start or rewrite a deleted Agent: `AgentControl`
 * (execute/publishStart/recover), `ManageAgents.update`, `AgentEnvironment.save`,
 * `ChangeAgentRuntimeCredential`, and `DirectConversations.authorize` for a send. `deletedAt` is optional so both the raw Prisma row and the
 * `AgentRecord` projection (where absence means "not deleted") satisfy it.
 */
export function assertAgentLive(agent: { deletedAt?: Date | null }): void {
  if (agent.deletedAt) throw new AppError("NOT_FOUND");
}

/**
 * Agents but an app's bot: what people's Agent rosters list (the sidebar, the Members page, a
 * person's own Agents). A bot shows on its app's detail and through its profile and mention card,
 * and pickers that add members to a channel still offer it. A bare `not` would drop the `null` kind
 * of every ordinary Agent.
 */
export const ROSTER_AGENT_WHERE = {
  OR: [{ systemKind: null }, { systemKind: { not: APP_BOT_KIND } }],
} satisfies Prisma.AgentWhereInput;

/**
 * Refuse an ordinary edit of an app's bot (`server/app-bots/`): it has no Computer and none may be
 * chosen for it, and its visibility is the app's grant, not its creator's setting. The grant and
 * revoke in Settings are its only controls.
 */
export function assertNotAppBot(agent: { systemKind?: string | null }): void {
  if (isAppBot(agent)) throw new AppError("ACCESS_DENIED", { errorId: "app-bot-managed" });
}
