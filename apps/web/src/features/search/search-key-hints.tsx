import { m } from "#src/paraglide/messages";

/** A key as search shows it: the sidebar field's shortcut and the panel's foot. */
export const SEARCH_KEY =
  "inline-flex min-w-5 shrink-0 justify-center rounded-sm px-1 font-body text-xs text-tertiary ring-1 ring-primary ring-inset";

const HINTS = [
  { keys: ["↑", "↓"], label: m.search_hint_select },
  { keys: ["↵"], label: m.search_hint_open },
  { keys: ["Esc"], label: m.controls_close },
];

/** The keys that drive search, along the panel's foot. A phone has no keyboard, so none there. */
export function SearchKeyHints() {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center gap-4 border-t border-secondary px-4 py-2 text-xs text-tertiary max-sm:hidden"
    >
      {HINTS.map(({ keys, label }) => (
        <span key={keys.join()} className="flex items-center gap-1">
          {keys.map((key) => (
            <kbd key={key} className={SEARCH_KEY}>
              {key}
            </kbd>
          ))}
          {label()}
        </span>
      ))}
    </div>
  );
}
