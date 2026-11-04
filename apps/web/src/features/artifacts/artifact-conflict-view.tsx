import { useState } from "react";
import { Check, Edit05 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import { TextArea } from "#src/components/base/textarea/textarea";
import { MessageBody } from "#src/features/conversations/message-body";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  ownDraft,
  type ConflictChoice,
  type ConflictResolution,
  type SettingConflict,
} from "./artifact-conflict-model";

const SETTING_LABEL: Record<SettingConflict["name"], () => string> = {
  title: () => m.doc_setting_title(),
  description: () => m.doc_setting_description(),
  entryPath: () => m.doc_setting_entryPath(),
};

/**
 * A save's conflicts in the document (task #385): the settings first (the title), then the text,
 * agreed parts as they read and each conflict a numbered card where the viewer picks their side,
 * the latest version's, or writes it themself from both. Picks change `resolution`; saving is
 * the pane's.
 */
export function ArtifactConflictView({
  resolution,
  onChange,
  disabled = false,
}: {
  resolution: ConflictResolution;
  onChange: (next: ConflictResolution) => void;
  /** While the picks are being saved: a pick changed then would not be in the save. */
  disabled?: boolean;
}) {
  let index = 0;
  const settingCards = resolution.settings.map((setting) => {
    index += 1;
    return (
      <ConflictCard
        disabled={disabled}
        key={`setting:${setting.name}`}
        heading={m.doc_conflict_setting({
          index: String(index),
          name: SETTING_LABEL[setting.name](),
        })}
        sides={setting}
        base={setting.base}
        choice={resolution.settingChoices[setting.name]}
        onChoose={(choice) =>
          onChange({
            ...resolution,
            settingChoices: { ...resolution.settingChoices, [setting.name]: choice },
          })
        }
      />
    );
  });
  let conflictIndex = -1;
  const body = resolution.chunks.map((chunk, position) => {
    if ("ok" in chunk)
      return chunk.ok.trim() ? (
        <div key={position} className="text-md text-secondary">
          <MessageBody body={chunk.ok} />
        </div>
      ) : null;
    conflictIndex += 1;
    index += 1;
    const at = conflictIndex;
    return (
      <ConflictCard
        disabled={disabled}
        key={position}
        heading={m.doc_conflict_text({ index: String(index) })}
        sides={chunk.conflict}
        base={chunk.conflict.base}
        markdown
        choice={resolution.textChoices[at]}
        onChoose={(choice) => {
          const textChoices = [...resolution.textChoices];
          textChoices[at] = choice;
          onChange({ ...resolution, textChoices });
        }}
      />
    );
  });
  return (
    <div className="flex flex-col gap-4">
      {settingCards}
      {body}
    </div>
  );
}

function ConflictCard({
  heading,
  sides,
  base,
  markdown,
  choice,
  onChoose,
  disabled,
}: {
  disabled: boolean;
  heading: string;
  sides: { mine: string; theirs: string };
  base: string | null;
  markdown?: boolean;
  choice: ConflictChoice | undefined;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const [showBase, setShowBase] = useState(false);
  const own = typeof choice === "object" ? choice.own : null;
  const picked = choice !== undefined;
  const text = (value: string) =>
    !value.trim() ? (
      <span className="text-tertiary italic">{m.doc_conflict_empty()}</span>
    ) : markdown ? (
      <MessageBody body={value} />
    ) : (
      <span className="break-words">{value}</span>
    );
  const option = (side: "mine" | "theirs", label: string) => (
    <RadioButton
      value={side}
      size="sm"
      label={label}
      hint={<span className="text-md text-primary">{text(sides[side])}</span>}
      className={({ isSelected, isDisabled }) =>
        cn(
          "cursor-pointer gap-3 border-t border-secondary px-3 py-2.5 outline-hidden",
          !isDisabled && "hover:bg-primary_hover",
          isSelected && "bg-brand-primary hover:bg-brand-primary",
        )
      }
    />
  );
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-primary",
        picked ? "border-secondary" : "border-utility-yellow-300",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2 px-3 py-2 text-sm",
          picked ? "bg-secondary" : "bg-warning-primary",
        )}
      >
        {picked ? (
          <Check aria-hidden="true" className="size-4 text-fg-success-primary" />
        ) : (
          <span aria-hidden="true" className="size-2 rounded-full bg-fg-warning-primary" />
        )}
        <h4 className="min-w-0 flex-1 font-semibold text-primary">{heading}</h4>
        {base !== null && (
          <Button size="xs" color="link-gray" onClick={() => setShowBase((shown) => !shown)}>
            {showBase ? m.doc_conflict_base_hide() : m.doc_conflict_base()}
          </Button>
        )}
      </header>
      {showBase && base !== null && (
        <div className="border-t border-secondary bg-secondary px-3 py-2 text-sm text-tertiary">
          {text(base)}
        </div>
      )}
      <RadioGroup
        aria-label={heading}
        className="gap-0"
        isDisabled={disabled}
        value={typeof choice === "string" ? choice : null}
        onChange={(value) => onChoose(value as "mine" | "theirs")}
      >
        {option("mine", m.doc_conflict_mine())}
        {option("theirs", m.doc_conflict_theirs())}
      </RadioGroup>
      <div className="flex flex-col gap-2 border-t border-secondary px-3 py-2.5">
        {own === null ? (
          <div className="flex items-center gap-3">
            <Button
              size="xs"
              color="secondary"
              iconLeading={Edit05}
              isDisabled={disabled}
              onClick={() => onChoose({ own: ownDraft(sides) })}
            >
              {m.doc_conflict_own()}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-tertiary">{m.doc_conflict_own_hint()}</p>
            <TextArea
              aria-label={m.doc_conflict_own()}
              isDisabled={disabled}
              value={own}
              rows={Math.min(10, Math.max(3, own.split("\n").length))}
              onChange={(value) => onChoose({ own: value })}
            />
          </>
        )}
      </div>
    </section>
  );
}
