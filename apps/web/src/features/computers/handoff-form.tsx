import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { AtSign } from "@untitledui/icons";
import { truncateCodePointsWithEllipsis, type LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Alert } from "#src/components/ui/alert";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { finishedAgentUsername, typedAgentUsername } from "#src/features/agents/agent-username";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import {
  briefingFirstMessage,
  buildBriefing,
  defaultAgentName,
  freeAgentName,
} from "./handoff-briefing";
import { HandoffProgress, HandoffRefusal } from "./handoff-states";
import { isRecentlyActive, sessionSummary } from "./local-session-list";
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
  // What the person typed; until they do, the Agent's name is the default.
  const [typed, setTyped] = useState<string>();
  const directory = useWorkspaceDirectory();
  // Agent names are unique in a Workspace; the ones the viewer can see are checked before submit.
  const taken = useMemo(
    () => new Set((directory.data?.agents ?? []).map((agent) => agent.handle.toLowerCase())),
    [directory.data],
  );
  const [active] = useState(() => isRecentlyActive(session.updatedAtMs, Date.now()));
  const excerpt = useLocalSessionExcerpt(computerId, session);
  const { submit, pending, error, createdName, briefingFailed } = useHandoffCreate({
    onDone: onClose,
  });
  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);

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
        ? ""
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

  const locked = pending || createdName !== undefined;
  // Until the person types a name, the default steps past names already taken; once the Agent
  // exists its name stays, so a resend can never be read as a second Agent.
  const shownName =
    createdName ?? typed ?? freeAgentName(defaultAgentName(session.cwd, tool), taken);
  const username = finishedAgentUsername(shownName);
  const nameTaken = createdName === undefined && taken.has(username.toLowerCase());
  const canSubmit = createdName !== undefined || (username !== "" && !nameTaken && !blocked);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    void submit(
      {
        name: username,
        description: m.handoff_agent_description({
          tool,
          cwd: truncateCodePointsWithEllipsis(session.cwd.trim(), DESCRIPTION_CWD_MAX - 1),
        }),
        provider: session.provider,
        model: model || undefined,
        computerId,
        visibility: AGENT_VISIBILITY.PUBLIC,
      },
      briefing,
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <SelectedSession session={session} onChooseAnother={onChooseAnother} disabled={locked} />
      {active && <Alert color="warning" description={m.handoff_active_warning({ tool })} />}
      <Input
        label={m.handoff_agent_name()}
        size="sm"
        icon={AtSign}
        isRequired
        hideRequiredIndicator
        isReadOnly={locked}
        value={shownName}
        isInvalid={nameTaken}
        hint={nameTaken ? m.agent_form_name_taken() : undefined}
        onChange={(text) => setTyped(typedAgentUsername(text))}
        onBlur={() =>
          setTyped((current) => (current === undefined ? current : finishedAgentUsername(current)))
        }
      />
      <ExcerptNotice state={excerpt.state} onRetry={excerpt.retry} />
      {excerpt.state.kind === "loading" && <HandoffProgress label={m.handoff_loading()} />}
      {!blocked && <BriefingPreview text={briefing} />}
      {error && <Alert color="error" description={error} />}
      {briefingFailed && (
        <Alert color="error" description={m.handoff_briefing_failed({ name: shownName })} />
      )}
      <DialogActions>
        <DialogCancel type="button" isDisabled={pending} onPress={onClose}>
          {m.controls_cancel()}
        </DialogCancel>
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
  // The session's directory and model, once: the briefing below repeats them in full.
  const { title, place } = sessionSummary(session);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-secondary p-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-primary">
          {title || m.handoff_untitled()}
        </div>
        <div className="truncate text-xs text-tertiary">{place}</div>
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

function BriefingPreview({ text }: { text: string }) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-sm font-medium text-secondary">
        {m.handoff_briefing_preview()}
      </p>
      <div
        role="region"
        aria-labelledby={labelId}
        tabIndex={0}
        className="max-h-48 overflow-y-auto rounded-lg border border-secondary bg-secondary p-3 text-sm whitespace-pre-wrap text-secondary outline-focus-ring focus-visible:outline-2"
      >
        {text}
      </div>
    </div>
  );
}
