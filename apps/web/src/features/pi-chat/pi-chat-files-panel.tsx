import type { ComponentProps } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";

import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { PiChatFiles } from "./pi-chat-files";

export function PiChatFilesPanel(props: ComponentProps<typeof PiChatFiles>) {
  useHotkey(
    "Escape",
    () => {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) === null) props.onClose();
    },
    { ignoreInputs: true, preventDefault: false },
  );

  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary max-lg:border-l max-lg:border-secondary">
      <PiChatFiles {...props} />
    </aside>
  );
}
