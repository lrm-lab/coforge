import { cx } from "#src/utils/cx";

import cloud from "./illustrations/agent-cloud.svg?url";
import local from "./illustrations/agent-local.svg?url";

/**
 * The new-Agent dialog's two pictures, one per place an Agent runs: the designer's drawings
 * (task #105), bundled under hashed names so an edited one reaches every browser. Decorative: the
 * label beside each says what it shows. Each keeps its own proportions inside the box it is given.
 */
function picture(src: string) {
  return function AgentIllustration({ className }: { className?: string }) {
    return (
      <img src={src} alt="" aria-hidden="true" className={cx("block object-contain", className)} />
    );
  };
}

/** A cloud with an upload arrow, mascots around it. */
export const CloudAgentIllustration = picture(cloud);

/** A laptop showing a chat, mascots around it. */
export const LocalAgentIllustration = picture(local);

/** The dialog's two illustrations, one per kind of Agent. */
export const AGENT_ILLUSTRATIONS = {
  cloud: CloudAgentIllustration,
  local: LocalAgentIllustration,
  external: LocalAgentIllustration,
} as const;
