import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";

/** The spinner a message's video shows while it loads, over the frame's black; it lets presses
 * through to the player beneath. */
export function InlineVideoSpinner() {
  return (
    <span
      role="status"
      aria-label={m.conversation_video_loading()}
      className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/80"
    >
      <Spinner className="size-8" />
    </span>
  );
}
