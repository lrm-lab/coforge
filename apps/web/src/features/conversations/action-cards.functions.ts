import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppRecoverOwnerActionCards } from "#src/server/conversations/app-recover-owner-action-cards.server";
import { AppRegisterActionCards } from "#src/server/conversations/app-register-action-cards.server";
import { createAppRegistrationNotices } from "#src/server/apps/app-registration-notices-composition.server";
import { AppGrantActionCards } from "#src/server/conversations/app-grant-action-cards.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { commitPageFillCard } from "#src/server/conversations/action-card-page-fill.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { createAppAgentAccess } from "#src/server/app-agent-access/app-agent-access-composition.server";

/**
 * Human commit/cancel Server Functions for Agent-prepared action cards.
 * `channel:create` and `channel:add_member` commit here, reusing `PublicChannels`
 * through `ActionCards`. `agent:create` commits through the existing `createAgent` Server
 * Function in `agents.functions.ts` instead (it already submits the human's full runtime form and
 * enforces `assertCanCreateAgents`); this module only guards it before and marks it after — see
 * `agents.functions.ts#createAgent`.
 */

function actionCards(db: ConstructorParameters<typeof ActionCards>[0]) {
  const centrifugo = createCentrifugoServerApi();
  return new ActionCards(db, undefined, new CentrifugoConversationRealtime(centrifugo));
}

const messageIdInput = z.object({ messageId: z.uuid() });

const commitChannelCreateInput = messageIdInput.extend({
  name: z.string().trim().regex(CHANNEL_NAME_PATTERN),
  projectId: z.uuid().optional(),
  memberUserIds: z.array(z.uuid()).default([]),
  memberAgentIds: z.array(z.uuid()).default([]),
});

const commitChannelAddMemberInput = messageIdInput.extend({
  channelId: z.uuid(),
  userIds: z.array(z.uuid()).default([]),
  agentIds: z.array(z.uuid()).default([]),
});

export const commitChannelCreateActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commitChannelCreateInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    return actionCards(db).commitChannelCreate(
      { workspaceId, actorUserId: user.id },
      {
        messageId: data.messageId,
        name: data.name,
        projectId: data.projectId,
        memberUserIds: data.memberUserIds,
        memberAgentIds: data.memberAgentIds,
      },
    );
  });

export const commitChannelAddMemberActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commitChannelAddMemberInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    return actionCards(db).commitChannelAddMember(
      { workspaceId, actorUserId: user.id },
      {
        messageId: data.messageId,
        channelId: data.channelId,
        userIds: data.userIds,
        agentIds: data.agentIds,
      },
    );
  });

/** `app:grant_agent`: approving the card approves the Agent's request for the app. */
export const commitAppGrantActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput.extend({ scopes: z.array(z.string().max(32)).max(8) }))
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    await new AppGrantActionCards(db).commit(
      { workspaceId, userId: user.id },
      data.messageId,
      createAppAgentAccess(db),
      data.scopes,
    );
  });

/** `app:grant_agent`: the card's cancel, which denies the Agent's request. */
export const denyAppGrantActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    await new AppGrantActionCards(db).deny(
      { workspaceId, userId: user.id },
      data.messageId,
      createAppAgentAccess(db),
    );
  });

/** `app:register`: committing the card registers the app for the Agent that prepared it. The
 * client secret goes to that Agent in a private notice, never in this answer. */
export const commitAppRegisterActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    const centrifugo = createCentrifugoServerApi();
    return new AppRegisterActionCards(
      db,
      new CentrifugoConversationRealtime(centrifugo),
      createAppRegistrationNotices(db, centrifugo),
    ).commit({ workspaceId, userId: user.id }, data.messageId);
  });

/** `app:recover_owner`: committing the card makes the named Agent the app's owner Agent. */
export const commitAppRecoverOwnerActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) =>
    new AppRecoverOwnerActionCards(
      db,
      new CentrifugoConversationRealtime(createCentrifugoServerApi()),
    ).commit({ workspaceId, userId: user.id }, data.messageId),
  );

/** `page:fill`: type the submitted values into the Agent's browser. They are not stored. */
export const commitPageFillActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    messageIdInput.extend({
      values: z.record(z.string().max(32), z.string().max(2000)),
    }),
  )
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    const centrifugo = createCentrifugoServerApi();
    return commitPageFillCard(
      db,
      new CentrifugoConversationRealtime(centrifugo),
      { workspaceId, actorUserId: user.id },
      {
        messageId: data.messageId,
        values: data.values,
        cookie: getRequest().headers.get("cookie") ?? "",
      },
    );
  });

export const cancelActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    await actionCards(db).cancel({ workspaceId, actorUserId: user.id }, data.messageId);
  });

/** Refreshes just the pending cards currently shown in an open conversation: called on a
 * realtime signal for that conversation and on window focus (see `use-conversation-view.ts`'s
 * caller in `threaded-conversation.tsx`/`channel-conversation.tsx`), instead of re-fetching the
 * whole message page. */
export const loadActionCardStates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ messageIds: z.array(z.uuid()).max(200) }))
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    const views = await new ActionCards(db).viewsFor(workspaceId, user.id, data.messageIds);
    return Object.fromEntries(views);
  });
