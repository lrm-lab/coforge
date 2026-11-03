import { useEffect, useMemo, useState, type FormEvent } from "react";
import { truncateCodePointsWithEllipsis, type LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { finishedAgentUsername } from "#src/features/agents/agent-username";
import { AgentUsernameField } from "#src/features/agents/agent-username-field";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import { briefingFirstMessage, buildBriefing } from "./handoff-briefing";
import { HandoffBriefingView } from "./handoff-briefing-view";
import { HandoffProgress, HandoffRefusal } from "./handoff-states";
import { isRecentlyActive } from "./local-session-list";
import type { SessionExcerptState } from "./local-session-state";
import { useHandoffCreate } from "./use-handoff-create";
import { useLocalSessionExcerpt } from "./use-local-session-handoff";

/** The working directory is in the Agent's description once; far under the description's cap. */
const DESCRIPTION_CWD_MAX = 1_000;

/**
 * The handoff dialog's second step: the chosen session, the Agent it becomes and the briefing that
 * Agent will be sent, which the person reads before anything is created.
 */
export function HandoffForm({
  computerId,
  session,
  onChooseAnother,
  onClose,
  onBusyChange,
}: {
  computerId: string;
  session: LocalSessionEntry;
  onChooseAnother: () => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const tool = runtimeProviderLabel(session.provider);
  const [active] = useState(() => isRecentlyActive(session.updatedAtMs, Date.now()));
  const excerpt = useLocalSessionExcerpt(computerId, session);
  const { submit, pending, error, createdName, briefingFailed, openConversation } =
    useHandoffCreate({
      onDone: onClose,
    });
  const dmOpen = openConversation !== undefined;
  useEffect(() => {
    // Once the Agent's direct conversation is open, closing would lose the resend: the dialog stays
    // until the briefing is delivered or the person leaves for that conversation.
    onBusyChange(pending || dmOpen);
    return () => onBusyChange(false);
  }, [pending, dmOpen, onBusyChange]);

  const model = session.model.trim();
  const ready = excerpt.state.kind === "ready" ? excerpt.state.excerpt : undefined;
  const modelLabel = model || ready?.model.trim() || m.handoff_model_default();
  const blocked =
    excerpt.state.kind === "loading" ||
    excerpt.state.kind === "offline" ||
    excerpt.state.kind === "unsupported";
  // Nothing is sent while the excerpt is blocked, so there is nothing to build then.
  const briefing = useMemo(
    () =>
      blocked
        ? undefined
        : buildBriefing({
            firstMessage: briefingFirstMessage(ready?.initialRequest, session.title),
            turns: ready?.recentTurns ?? [],
            roles: { user: m.handoff_role_user(), assistant: m.handoff_role_assistant() },
            render: ({ firstMessage, recent }) =>
              m.handoff_briefing({
                tool,
                model: modelLabel,
                cwd: session.cwd,
                firstMessage,
                recent,
              }),
          }),
    [blocked, ready, session.title, session.cwd, tool, modelLabel],
  );

  // Once the Agent exists its name stays, so a resend can never be read as a second Agent. The
  // name field checks itself: the form does not submit while it is empty or taken.
  const locked = pending || createdName !== undefined;
  // What is sent: the person's own text once they have edited it, else the briefing as built.
  const [editedText, setEditedText] = useState<string>();
  const text = editedText ?? briefing?.text ?? "";
  const canSubmit = createdName !== undefined || (!blocked && text.trim() !== "");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const name =
      createdName ?? finishedAgentUsername(String(new FormData(event.currentTarget).get("name")));
    void submit(
      {
        name,
        description: m.handoff_agent_description({
          tool,
          cwd: truncateCodePointsWithEllipsis(session.cwd.trim(), DESCRIPTION_CWD_MAX - 1),
        }),
        provider: session.provider,
        model: model || undefined,
        computerId,
        visibility: AGENT_VISIBILITY.PUBLIC,
      },
      text,
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <SelectedSession session={session} onChooseAnother={onChooseAnother} disabled={locked} />
      {active && <Alert color="warning" description={m.handoff_active_warning({ tool })} />}
      <AgentUsernameField isReadOnly={locked} />
      <ExcerptNotice state={excerpt.state} onRetry={excerpt.retry} />
      {excerpt.state.kind === "loading" && <HandoffProgress label={m.handoff_loading()} />}
      {briefing && (
        <HandoffBriefingView
          briefing={briefing}
          editedText={editedText}
          onEditedTextChange={setEditedText}
          isReadOnly={locked}
          tool={tool}
          model={modelLabel}
          cwd={session.cwd}
        />
      )}
      {error && <Alert color="error" description={error} />}
      {briefingFailed && (
        <Alert color="error" description={m.handoff_briefing_failed({ name: createdName ?? "" })} />
      )}
      <DialogActions>
        {openConversation ? (
          <DialogCancel type="button" isDisabled={pending} onPress={() => void openConversation()}>
            {m.handoff_open_dm()}
          </DialogCancel>
        ) : (
          <DialogCancel type="button" isDisabled={pending} onPress={onClose}>
            {m.controls_cancel()}
          </DialogCancel>
        )}
        <DialogAction
          type="submit"
          isDisabled={!canSubmit}
          isLoading={pending}
          showTextWhileLoading
        >
          {createdName !== undefined
            ? m.handoff_resend()
            : pending
              ? m.handoff_creating()
              : m.handoff_submit()}
        </DialogAction>
      </DialogActions>
    </form>
  );
}

function SelectedSession({
  session,
  onChooseAnother,
  disabled,
}: {
  session: LocalSessionEntry;
  onChooseAnother: () => void;
  disabled: boolean;
}) {
  // Only its title: where it ran and on which model are the briefing's first lines below.
  const title = session.title.trim();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-secondary p-3">
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
        {title || m.handoff_untitled()}
      </div>
      <Button
        type="button"
        color="link-color"
        size="sm"
        isDisabled={disabled}
        onPress={onChooseAnother}
      >
        {m.handoff_choose_another()}
      </Button>
    </div>
  );
}

function ExcerptNotice({ state, onRetry }: { state: SessionExcerptState; onRetry: () => void }) {
  switch (state.kind) {
    case "failed":
      return <HandoffRefusal color="warning" text={m.handoff_excerpt_failed()} />;
    case "busy":
      return <HandoffRefusal color="gray" text={m.handoff_excerpt_busy()} onRetry={onRetry} />;
    case "offline":
      return <HandoffRefusal color="warning" text={m.handoff_offline()} onRetry={onRetry} />;
    case "unsupported":
      return <HandoffRefusal color="warning" text={m.handoff_unsupported()} />;
    default:
      return null;
  }
}
