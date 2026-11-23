import { Keycap } from "#src/components/ui/kbd";
import { m } from "#src/paraglide/messages";

const HINTS = [
  { keys: ["↑", "↓"], label: m.search_hint_select },
  { keys: ["↵"], label: m.search_hint_open },
  { keys: ["Esc"], label: m.controls_close },
];

export function SearchKeyHints() {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center gap-4 border-t border-secondary px-4 py-2 text-xs text-tertiary max-sm:hidden"
    >
      {HINTS.map(({ keys, label }) => (
        <span key={keys.join()} className="flex items-center gap-1">
          {keys.map((key) => (
            <Keycap key={key}>{key}</Keycap>
          ))}
          {label()}
        </span>
      ))}
    </div>
  );
}
