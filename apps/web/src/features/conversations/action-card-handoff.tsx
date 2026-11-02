import type { Dispatch, SetStateAction } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

/** Page-fill fields the owner types into; values never go into chat. */
export function ActionCardPageFillBody({
  view,
  fillValues,
  setFillValues,
}: {
  view: Extract<ActionCardView, { kind: "page:fill" }>;
  fillValues: Record<string, string>;
  setFillValues: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return (
    <>
      {view.prompt && <p>{view.prompt}</p>}
      <p className="text-tertiary">{m.action_card_page_fill_note()}</p>
      {view.state === "pending" && view.canCommit && (
        <div className="flex flex-col gap-2 pt-1">
          {view.fields.map((field) => (
            <label key={field.id} className="flex flex-col gap-1">
              <span className="text-xs text-tertiary">{field.label}</span>
              <input
                type={field.input === "password" ? "password" : "text"}
                autoComplete="off"
                value={fillValues[field.id] ?? ""}
                onChange={(event) =>
                  setFillValues((current) => ({ ...current, [field.id]: event.target.value }))
                }
                className="w-full rounded-md border border-secondary bg-primary px-2.5 py-1.5 text-sm text-primary outline-none"
              />
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** Prompt the owner to finish a step on the Agent's cloud desktop themselves. */
export function ActionCardDesktopTakeoverBody({
  view,
}: {
  view: Extract<ActionCardView, { kind: "desktop:takeover" }>;
}) {
  return (
    <>
      {view.prompt && <p>{view.prompt}</p>}
      <p className="text-tertiary">{m.action_card_desktop_takeover_note()}</p>
    </>
  );
}

/** Structured choice options; free-text reply stays available in chat when allowed. */
export function ActionCardChoiceBody({
  view,
  approving,
  onPick,
}: {
  view: Extract<ActionCardView, { kind: "choice" }>;
  approving: boolean;
  onPick: (optionId: string) => void;
}) {
  return (
    <>
      <p>{view.prompt}</p>
      {view.allowFreeText && <p className="text-tertiary">{m.action_card_choice_free_text()}</p>}
      {view.state === "pending" && view.canCommit && (
        <div className="flex flex-col gap-1 pt-1">
          {view.options.map((option) => (
            <Button
              key={option.id}
              color="secondary"
              size="sm"
              className="w-full justify-start whitespace-normal text-left"
              isDisabled={approving}
              onPress={() => onPick(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

/** Open the cloud desktop for page:fill / desktop:takeover while the card is pending. */
export function ActionCardOpenDesktopButton({
  enabled,
  onOpen,
}: {
  enabled: boolean;
  onOpen: () => void;
}) {
  if (!enabled) return null;
  return (
    <Button size="sm" color="secondary" onPress={onOpen}>
      {m.action_card_open_desktop()}
    </Button>
  );
}

/** Result suffix once a handoff card has been committed. */
export function ActionCardHandoffDoneSuffix({ view }: { view: ActionCardView }) {
  if (view.kind === "page:fill" && view.result) {
    return (
      <>
        {" · "}
        {m.action_card_page_fill_done()}
      </>
    );
  }
  if (view.kind === "desktop:takeover" && view.result) {
    return (
      <>
        {" · "}
        {m.action_card_desktop_takeover_done()}
      </>
    );
  }
  if (view.kind === "choice" && view.result) {
    return (
      <>
        {" · "}
        {m.action_card_choice_done({ label: view.result.label })}
      </>
    );
  }
  return null;
}
