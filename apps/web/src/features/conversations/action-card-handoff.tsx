import type { Dispatch, SetStateAction } from "react";

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
      {view.prompt && <p className="font-semibold text-primary">{view.prompt}</p>}
      {/* Who cannot fill it in still sees what the page asks for. */}
      {!view.canCommit && (
        <p className="text-tertiary">{view.fields.map((field) => field.label).join(" · ")}</p>
      )}
      <p className="text-tertiary">{m.action_card_page_fill_note()}</p>
      {view.canCommit && (
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
      {view.prompt && <p className="font-semibold text-primary">{view.prompt}</p>}
      <p className="text-tertiary">{m.action_card_desktop_takeover_note()}</p>
    </>
  );
}
