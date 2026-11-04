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
  commitChoiceActionCard,
  commitDesktopTakeoverActionCard,
  commitPageFillActionCard,
  denyAppGrantActionCard,
  loadActionCardStates,
} from "./action-cards.functions";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ChannelAddMembersDialog } from "./channel-add-members-dialog";
import { ChoiceActionCard } from "./action-card-choice";
import { HandledActionCard } from "./action-card-handled";
import { PendingActionCard, type ActionCardFailure } from "./action-card-pending";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { getCloudDesktopOrigin } from "#src/features/computers/cloud-desktop-origin.functions";
import { cloudDesktopUrl, openCloudDesktopWindow } from "#src/features/computers/cloud-desktop-url";
import { WAITING_CHOICE_CARDS_KEY } from "#src/features/inbox/activity-inbox-queries";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

/** Renders an Agent-prepared action card below its message body.
 * Owns its own commit/cancel dialogs and a self-refresh after acting; the conversation view also
 * refreshes every currently pending card on realtime signals and window focus (see
 * `conversation-queries.ts`). */
/** Codes for a draft the server refuses as it is, which no Retry of it can change. */
const REFUSALS = ["INVALID_INPUT", "NOT_FOUND", "ACCESS_DENIED", "AGENT_NOT_VISIBLE"] as const;

export function ActionCard({ card }: { card: ActionCardView }) {
  const [view, setView] = useState(card);
  useEffect(() => setView(card), [card]);
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
  const commitChoice = useServerFn(commitChoiceActionCard);
  const queryClient = useQueryClient();
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  // Known only to someone in the channel, who alone may commit (task #302).
  const addMemberChannelId = view.kind === "channel:add_member" ? view.channel.id : null;
  // A commit in flight (the card's own button shows it), or the Computers an Agent's dialog lists
  // still loading.
  const [committing, setCommitting] = useState(false);
  const [openingDialog, setOpeningDialog] = useState(false);
  const create = useServerFn(createAgent);
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

  async function refetch() {
    const states = await refresh({ data: { messageIds: [view.messageId] } });
    const next = states[view.messageId] as ActionCardView | undefined;
    if (next) setView(next);
  }

  /** Runs a commit and shows the card as the server now has it. A failure says why, and the primary
   * button offers to send it again, unless `explain` knows that sending it again would not help. */
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
      // A conflict may be someone else's commit of this card: read it again, and a done card shows
      // as done instead of offering to send it again.
      if (isAppErrorCode(cause, "CONFLICT")) await refetch().catch(() => {});
      // The server refused the draft itself: sent again unchanged, it is refused the same way.
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
    // Committed: a read that fails here leaves the card to the conversation's own refresh, and
    // offers no Retry of a commit that went through.
    await refetch().catch(() => {});
    setCommitting(false);
  }

  async function doCancel() {
    setCancelling(true);
    setFailure(null);
    try {
      // An app approval card is cancelled by denying the Agent's request.
      await (view.kind === "app:grant_agent" ? denyAppGrant : cancel)({
        data: { messageId: view.messageId },
      });
      await refetch();
    } catch {
      setFailure({ message: m.action_card_error(), retry: false, from: "cancel" });
    } finally {
      setCancelling(false);
    }
  }

  async function pickChoice(optionId: string, text?: string) {
    setFailure(null);
    try {
      await commitChoice({ data: { messageId: view.messageId, optionId, text } });
      // Answered, it no longer waits on the viewer in Activity.
      void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY });
      await refetch();
    } catch {
      setFailure({ message: m.action_card_error(), retry: true, from: "commit" });
    }
  }

  /** An Agent's runtime form is the dialog's, and it lists the Computers, which are read first.
   * Nothing is created yet, so the button waits without saying so. */
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

  /** The primary button: commit the draft as the card shows it. Only a kind whose draft lacks
   * something (an Agent's runtime form) opens its dialog instead. */
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
            // A channel of that name exists by now: sending it again fails the same way, so the
            // button renames it.
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
        const channelId = addMemberChannelId;
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
              ? // The request asks for other scopes than the card showed: show the card again.
                { message: m.app_card_request_changed(), retry: false }
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

  if (view.kind === "choice")
    return (
      <ChoiceActionCard
        view={view}
        error={failure?.message ?? ""}
        cancelling={cancelling}
        onPick={pickChoice}
        onCancel={() => void doCancel()}
      />
    );
  return (
    <>
      {view.state === "pending" ? (
        <PendingActionCard
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
      ) : (
        // The dialogs below stay mounted past the commit they made, so they close on their own.
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
            await refetch();
          }}
        />
      )}
      {dialogOpen && view.kind === "channel:add_member" && addMemberChannelId && (
        <ChannelAddMembersDialog
          channelId={addMemberChannelId}
          channelName={view.channel.displayName}
          open
          onOpenChange={setDialogOpen}
          proposed={{ humans: view.humans, agents: view.agents }}
          commit={{
            submit: (input) =>
              commitAddMember({
                data: { messageId: view.messageId, channelId: addMemberChannelId, ...input },
              }),
            onCommitted: () => void refetch(),
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
          onCreate={(input) => create({ data: input })}
          onCreated={() => void refetch()}
        />
      )}
    </>
  );
}
