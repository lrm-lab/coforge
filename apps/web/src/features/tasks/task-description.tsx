import { useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** The description under the title, as Linear's issue. Beside the properties a long one is cut at
 * four lines, on a phone at two, and a tap shows the rest. */
export function TaskDescription({ text, short }: { text: string; short: boolean }) {
  const [open, setOpen] = useState(false);
  // Cut short so the discussion keeps its room; opened, a long one scrolls in place.
  const clamp = open ? "max-h-60 overflow-y-auto" : short ? "line-clamp-2" : "line-clamp-4";
  return (
    <Button
      color="link-gray"
      type="button"
      aria-expanded={open}
      aria-label={open ? m.tasks_description_less() : m.tasks_description_more()}
      onPress={() => setOpen((shown) => !shown)}
      className="mx-4 h-auto justify-start p-0 text-left text-sm font-normal whitespace-pre-wrap text-secondary sm:mx-6"
    >
      <span className={cn("block", clamp)}>{text}</span>
    </Button>
  );
}
