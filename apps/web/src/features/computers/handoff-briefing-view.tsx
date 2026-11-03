import { useId, useState, type ReactNode } from "react";
import { Focusable } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { DIRECT_MESSAGE_MAX_LENGTH } from "#src/features/conversations/conversation.schemas";
import { CollapsibleMessageBody } from "#src/features/conversations/collapsible-message-body";
import { m } from "#src/paraglide/messages";
import type { Briefing } from "./handoff-briefing";

/**
 * The briefing the new Agent will be sent, laid out to be read: where the session ran as a few
 * properties, then the opening request and the recent exchanges as Markdown, each folded past a
 * few lines. Edit turns it into the text that is sent, to change as the person likes; once
 * changed, that text is what is shown, whole and rendered as Markdown, so the change is in view.
 * The dialog scrolls, never this.
 */
export function HandoffBriefingView({
  briefing,
  editedText,
  onEditedTextChange,
  isReadOnly,
  tool,
  model,
  cwd,
}: {
  briefing: Briefing;
  /** The person's own text for the briefing, once they have changed it. */
  editedText: string | undefined;
  onEditedTextChange: (text: string | undefined) => void;
  isReadOnly: boolean;
  tool: string;
  model: string;
  cwd: string;
}) {
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const text = editedText ?? briefing.text;
  const roles = { user: m.handoff_role_user(), assistant: m.handoff_role_assistant() };
  const recent = briefing.turns.map((turn) => `**${roles[turn.role]}**: ${turn.text}`).join("\n\n");

  function toggle() {
    if (!editing) {
      onEditedTextChange(text);
      setEditing(true);
      return;
    }
    // Put back as it was, it is the briefing as built again: the parts show on their own.
    if (editedText === briefing.text) onEditedTextChange(undefined);
    setEditing(false);
  }

  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <h3 id={labelId} className="text-sm font-medium text-secondary">
          {m.handoff_briefing_preview()}
        </h3>
        <Button
          type="button"
          color="link-color"
          size="sm"
          isDisabled={isReadOnly || (editing && !text.trim())}
          onPress={toggle}
        >
          {editing ? m.handoff_briefing_done() : m.handoff_briefing_edit()}
        </Button>
      </div>
      {editing ? (
        <TextArea
          aria-labelledby={labelId}
          value={text}
          onChange={onEditedTextChange}
          maxLength={DIRECT_MESSAGE_MAX_LENGTH}
          autoFocus
          size="sm"
          textAreaClassName="field-sizing-content min-h-40"
        />
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-secondary p-4">
          {editedText !== undefined ? (
            <Fold body={editedText} whole />
          ) : (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
                <dt className="text-tertiary">{m.handoff_briefing_tool()}</dt>
                <dd className="min-w-0 text-primary">{tool}</dd>
                <dt className="text-tertiary">{m.handoff_briefing_model()}</dt>
                <dd className="min-w-0 text-primary">{model}</dd>
                <dt className="text-tertiary">{m.handoff_briefing_cwd()}</dt>
                <dd className="min-w-0">
                  <Directory path={cwd} />
                </dd>
              </dl>
              <Section label={m.handoff_briefing_first()}>
                <Fold body={briefing.firstMessage} />
              </Section>
              <Section label={m.handoff_briefing_recent()}>
                <Fold body={recent || "-"} />
              </Section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Markdown folded past a few lines, like a long message; `whole` shows it all. */
function Fold({ body, whole = false }: { body: string; whole?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="min-w-0 text-primary">
      <CollapsibleMessageBody
        body={body}
        collapsible={!whole}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((open) => !open)}
      />
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-secondary pt-4">
      <h4 className="text-xs font-medium text-tertiary">{label}</h4>
      {children}
    </div>
  );
}

/**
 * A directory on one line in monospace: when it does not fit, the middle gives way and the last
 * folder stays (itself cut at the end only when it alone is too wide), and the whole path is in a
 * tooltip.
 */
function Directory({ path }: { path: string }) {
  const cut = path.replace(/[\\/]+$/, "").search(/[^\\/]*$/);
  const head = cut > 0 ? path.slice(0, cut) : "";
  const tail = cut > 0 ? path.slice(cut) : path;
  return (
    <Tooltip title={path}>
      <Focusable>
        <span
          tabIndex={0}
          className="flex min-w-0 rounded-sm font-mono text-xs text-primary outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <span className="truncate">{head}</span>
          <span className="max-w-full shrink-0 truncate">{tail}</span>
        </span>
      </Focusable>
    </Tooltip>
  );
}
