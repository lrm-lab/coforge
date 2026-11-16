import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { m } from "#src/paraglide/messages";
import { isAppErrorCode } from "#src/lib/app-error";
import { APP_GRANT_REQUEST_CHANGED } from "#src/features/apps/agent-app-access";
import {
  cancelActionCard,
  commitChannelAddMemberActionCard,
  commitAppGrantActionCard,
  commitAppRecoverOwnerActionCard,
  commitAppRegisterActionCard,
  commitChannelCreateActionCard,
  commitDesktopTakeoverActionCard,
  commitPageFillActionCard,
  denyAppGrantActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ChannelAddMembersDialog } from "./channel-add-members-dialog";
import { HandledActionCard, SettledActionCard } from "./action-card-handled";
import type { ToolActionCardView } from "./action-card-labels";
import { isAskingView } from "./question-dock-model";
import { useConversationId } from "./conversation-id";
import { useSettleInPlace } from "./settle-in-place";
import { updateLoadedMessage } from "./conversation-queries";
import { QuestionCard } from "./question-card";
import { PendingActionCard, type ActionCardFailure } from "./action-card-pending";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { useCreateAgent } from "#src/features/agents/use-create-agent";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { getCloudDesktopOrigin } from "#src/features/computers/cloud-desktop-origin.functions";
import { cloudDesktopUrl, openCloudDesktopWindow } from "#src/features/computers/cloud-desktop-url";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

const REFUSALS = ["INVALID_INPUT", "NOT_FOUND", "ACCESS_DENIED", "AGENT_NOT_VISIBLE"] as const;

const KNOWN_KINDS: Record<ActionCardView["kind"], true> = {
  "channel:create": true,
  "channel:add_member": true,
  "agent:create": true,
  "app:grant_agent": true,
  "app:register": true,
  "app:recover_owner": true,
  "page:fill": true,
  "desktop:takeover": true,
  choice: true,
  questions: true,
};

export function ActionCard({ card }: { card: ActionCardView }) {
  if (!Object.hasOwn(KNOWN_KINDS, card.kind))
    return (
      <p
        data-action-card-unknown=""
        className="mt-1 max-w-md rounded-xl border border-secondary px-3 py-2.5 text-sm text-tertiary"
      >
        {m.action_card_unknown()}
      </p>
    );
  if (card.kind === "choice" || card.kind === "questions") return <QuestionCard card={card} />;
  return <KnownActionCard card={card} />;
}

function KnownActionCard({ card }: { card: ToolActionCardView }) {
  const [view, setView] = useState(card);
  useEffect(() => setView(card), [card]);
  const [handledHere, setHandledHere] = useState(false);
  const { box, settles, heldHeight } = useSettleInPlace(view, handledHere);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<ActionCardFailure | null>(null);
  const cancel = useServerFn(cancelActionCard);
  const refresh = useServerFn(loadActionCardStates);
  const commitChannelCreate = useServerFn(commitChannelCreateActionCard);
  const commitAddMember = useServerFn(commitChannelAddMemberActionCard);
  const approveAppGrant = useServerFn(commitAppGrantActionCard);
  const denyAppGrant = useServerFn(denyAppGrantActionCard);
  const registerApp = useServerFn(commitAppRegisterActionCard);
  const recoverOwner = useServerFn(commitAppRecoverOwnerActionCard);
  const commitFill = useServerFn(commitPageFillActionCard);
  const commitDesktop = useServerFn(commitDesktopTakeoverActionCard);
  const queryClient = useQueryClient();
  const conversationId = useConversationId();
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const addMemberChannel =
    view.kind === "channel:add_member" && view.channel.id ? view.channel : null;
  const [committing, setCommitting] = useState(false);
  const [openingDialog, setOpeningDialog] = useState(false);
  const create = useCreateAgent();
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();
  const loadDesktopOrigin = useServerFn(getCloudDesktopOrigin);
  const desktopComputerId =
    view.kind === "page:fill" || view.kind === "desktop:takeover" ? view.computerId : undefined;
  const desktopAgentId =
    view.kind === "page:fill" || view.kind === "desktop:takeover" ? view.agentId : undefined;
  const desktopTitle = view.kind === "desktop:takeover" ? view.agentName : undefined;
  const desktopOrigin = useQuery({
    queryKey: ["cloud-desktop-origin"],
    queryFn: () => loadDesktopOrigin(),
    enabled: view.state === "pending" && Boolean(desktopComputerId && desktopAgentId),
    staleTime: 60_000,
  });
  const desktopUrl =
    desktopOrigin.data && desktopComputerId && desktopAgentId
      ? cloudDesktopUrl(desktopOrigin.data, desktopComputerId, desktopAgentId, desktopTitle)
      : undefined;

  function openDesktop() {
    if (!desktopUrl || !desktopComputerId || !desktopAgentId) return;
    openCloudDesktopWindow(desktopUrl, desktopComputerId, desktopAgentId);
  }

  function refetchOwn() {
    setHandledHere(true);
    return refetch();
  }

  async function refetch() {
    const states = await refresh({ data: { messageIds: [view.messageId] } });
    const next = states[view.messageId];
    if (!next || isAskingView(next)) return;
    setView(next);
    if (conversationId)
      updateLoadedMessage(queryClient, conversationId, view.messageId, (message) => ({
        ...message,
        actionCard: next,
      }));
  }

  async function commit(
    send: () => Promise<unknown>,
    explain?: (
      cause: unknown,
    ) => (Partial<Pick<ActionCardFailure, "retry" | "fix">> & { message: string }) | undefined,
  ) {
    setCommitting(true);
    setFailure(null);
    try {
      await send();
    } catch (cause) {
      const known = explain?.(cause);
      if (isAppErrorCode(cause, "CONFLICT")) await refetch().catch(() => {});
      const refused = isAppErrorCode(cause, ...REFUSALS);
      setFailure({
        message: known?.message ?? (refused ? m.action_card_refused() : m.action_card_error()),
        retry: known?.retry ?? !refused,
        fix: known?.fix,
        from: "commit",
      });
      setCommitting(false);
      return;
    }
    await refetchOwn().catch(() => {});
    setCommitting(false);
  }

  async function doCancel() {
    setCancelling(true);
    setFailure(null);
    try {
      await (view.kind === "app:grant_agent" ? denyAppGrant : cancel)({
        data: { messageId: view.messageId },
      });
      await refetchOwn();
    } catch {
      setFailure({ message: m.action_card_error(), retry: false, from: "cancel" });
    } finally {
      setCancelling(false);
    }
  }

  async function openAgentDialog() {
    setOpeningDialog(true);
    setFailure(null);
    try {
      if (!computers) setComputers(await loadComputers());
      setDialogOpen(true);
    } catch {
      setFailure({ message: m.action_card_error(), retry: true, from: "commit" });
    } finally {
      setOpeningDialog(false);
    }
  }

  async function commitDraft() {
    switch (view.kind) {
      case "channel:create": {
        return commit(
          async () => {
            await commitChannelCreate({
              data: {
                messageId: view.messageId,
                name: view.name,
                memberUserIds: view.initialHumans.map((human) => human.id),
                memberAgentIds: view.initialAgents.map((agent) => agent.id),
              },
            });
          },
          (cause) =>
            isAppErrorCode(cause, "CONFLICT")
              ? {
                  message: m.action_card_channel_taken({ name: view.name }),
                  retry: false,
                  fix: "edit",
                }
              : undefined,
        );
      }
      case "channel:add_member": {
        const channelId = addMemberChannel?.id;
        if (!channelId) return;
        return commit(
          async () => {
            await commitAddMember({
              data: {
                messageId: view.messageId,
                channelId,
                userIds: view.humans.map((human) => human.id),
                agentIds: view.agents.map((agent) => agent.id),
              },
            });
            await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
          },
          (cause) =>
            isAppErrorCode(cause, "ACCESS_DENIED")
              ? { message: m.channel_members_access_denied(), retry: false }
              : undefined,
        );
      }
      case "agent:create":
        return openAgentDialog();
      case "app:grant_agent": {
        const scopes = view.scopes;
        return commit(
          () => approveAppGrant({ data: { messageId: view.messageId, scopes } }),
          (cause) =>
            isAppErrorCode(cause, "CONFLICT") && cause.errorId === APP_GRANT_REQUEST_CHANGED
              ? { message: m.app_card_request_changed(), retry: false }
              : undefined,
        );
      }
      case "app:register":
      case "app:recover_owner":
        return commit(() =>
          (view.kind === "app:recover_owner" ? recoverOwner : registerApp)({
            data: { messageId: view.messageId },
          }),
        );
      case "desktop:takeover":
        return commit(() => commitDesktop({ data: { messageId: view.messageId } }));
      case "page:fill":
        return commit(
          async () => {
            await commitFill({ data: { messageId: view.messageId, values: fillValues } });
            setFillValues({});
          },
          (cause) => {
            if (isAppErrorCode(cause, "TEMPORARILY_UNAVAILABLE")) {
              if (cause.errorId === "page-fill-browser")
                return { message: m.action_card_page_fill_browser(), retry: false };
              if (cause.errorId === "page-fill-desktop")
                return { message: m.action_card_page_fill_desktop() };
            }
            return isAppErrorCode(cause, "INVALID_INPUT") && cause.errorId === "page-fill-field"
              ? { message: m.action_card_page_fill_field(), retry: false }
              : undefined;
          },
        );
      default:
        return;
    }
  }

  return (
    <>
      {view.state === "pending" ? (
        <PendingActionCard
          frameRef={box}
          view={view}
          fillValues={fillValues}
          setFillValues={setFillValues}
          failure={failure}
          committing={committing}
          cancelling={cancelling}
          commitDisabled={
            openingDialog ||
            (view.kind === "page:fill" &&
              view.fields.some(
                (field) => field.input === "password" && !(fillValues[field.id] ?? "").length,
              ))
          }
          onCommit={() => void commitDraft()}
          onEdit={() => setDialogOpen(true)}
          onOpenDesktop={desktopUrl ? openDesktop : undefined}
          onCancel={() => void doCancel()}
        />
      ) : settles ? (
        <SettledActionCard frameRef={box} view={view} minHeight={heldHeight} />
      ) : (
        <HandledActionCard view={view} />
      )}
      {dialogOpen && view.kind === "channel:create" && (
        <CreateChannelDialog
          open
          onOpenChange={setDialogOpen}
          defaultName={view.name}
          initialMembers={{ humans: view.initialHumans, agents: view.initialAgents }}
          onCreate={async (name, memberUserIds, memberAgentIds) => {
            await commitChannelCreate({
              data: {
                messageId: view.messageId,
                name,
                memberUserIds: memberUserIds ?? [],
                memberAgentIds: memberAgentIds ?? [],
              },
            });
            await refetchOwn();
          }}
        />
      )}
      {dialogOpen && view.kind === "channel:add_member" && addMemberChannel && (
        <ChannelAddMembersDialog
          channelId={addMemberChannel.id}
          channelName={addMemberChannel.displayName}
          open
          onOpenChange={setDialogOpen}
          proposed={{ humans: view.humans, agents: view.agents }}
          commit={{
            submit: (input) =>
              commitAddMember({
                data: { messageId: view.messageId, channelId: addMemberChannel.id, ...input },
              }),
            onCommitted: () => void refetchOwn(),
          }}
        />
      )}
      {dialogOpen && view.kind === "agent:create" && computers && (
        <AgentCreateDialog
          open
          onOpenChange={setDialogOpen}
          computers={computers}
          onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
          defaults={{
            name: view.name,
            description: view.description,
            computerId: view.requiredComputer?.id ?? view.suggestedComputer?.id,
          }}
          computerLocked={Boolean(view.requiredComputer)}
          actionCardMessageId={view.messageId}
          onCreate={create}
          onCreated={() => void refetchOwn()}
        />
      )}
    </>
  );
}
