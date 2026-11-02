import { cx } from "#src/utils/cx";

import green from "./illustrations/green.svg?url";
import pink from "./illustrations/pink.svg?url";
import purple from "./illustrations/purple.svg?url";
import teal from "./illustrations/teal.svg?url";
import yellow from "./illustrations/yellow.svg?url";

/**
 * The new-Agent dialog's two pictures, one per place an Agent runs: drawn in the theme's brand
 * colours (`utility-brand-*` turns dark in dark mode) around the app's mascots, so both read on a
 * light and a dark dialog. Decorative: the label beside each says what it shows.
 */

/** The design file's vector mascots, bundled under hashed names so an edited one reaches every
 * browser. */
const MASCOTS = { green, pink, purple, teal, yellow };

function Mascot({
  name,
  x,
  y,
  size,
}: {
  name: keyof typeof MASCOTS;
  x: number;
  y: number;
  size: number;
}) {
  return <image href={MASCOTS[name]} x={x} y={y} width={size} height={size} />;
}

/** A cloud with an upload arrow, mascots around it. */
export function CloudAgentIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 106 66" aria-hidden="true" className={cx("block", className)}>
      <g className="fill-utility-brand-100">
        <circle cx="24" cy="44" r="12" />
        <circle cx="38" cy="36" r="13" />
        <circle cx="70" cy="34" r="14" />
        <circle cx="85" cy="44" r="11" />
        <rect x="8" y="44" width="90" height="16" rx="8" />
      </g>
      <g className="fill-utility-brand-400">
        <circle cx="44" cy="36" r="11" />
        <circle cx="55" cy="27" r="14" />
        <circle cx="67" cy="36" r="11" />
        <rect x="33" y="34" width="45" height="18" rx="9" />
      </g>
      <path
        d="M55 22.5 L61.5 30 H57.6 V39.5 H52.4 V30 H48.5 Z"
        className="fill-white stroke-white"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <g className="fill-utility-brand-50">
        <circle cx="30" cy="54" r="7" />
        <circle cx="76" cy="53" r="8" />
        <rect x="16" y="54" width="76" height="8" rx="4" />
      </g>
      <Mascot name="yellow" x={11} y={2} size={27} />
      <Mascot name="green" x={70} y={0} size={27} />
      <Mascot name="teal" x={7} y={32} size={24} />
    </svg>
  );
}

/** A laptop showing a chat, mascots around it. */
export function LocalAgentIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 106 66" aria-hidden="true" className={cx("block", className)}>
      <Mascot name="purple" x={20} y={1} size={28} />
      <Mascot name="teal" x={58} y={3} size={26} />
      <rect x="27" y="21" width="52" height="33" rx="4" className="fill-utility-brand-200" />
      <rect x="30" y="24" width="46" height="27" rx="2" className="fill-utility-brand-50" />
      <circle cx="53" cy="22.5" r="0.9" className="fill-utility-brand-400" />
      <rect x="33" y="27" width="9" height="21" rx="1.5" className="fill-utility-brand-100" />
      <circle cx="37.5" cy="31" r="1.8" className="fill-utility-brand-600" />
      <circle cx="37.5" cy="36" r="1.8" className="fill-utility-brand-200" />
      <circle cx="37.5" cy="41" r="1.8" className="fill-utility-brand-200" />
      <g className="fill-utility-brand-100">
        <rect x="45" y="27" width="28" height="9" rx="1.5" />
        <rect x="45" y="39" width="26" height="3" rx="1.5" />
        <rect x="45" y="44" width="18" height="3" rx="1.5" />
      </g>
      <path
        d="M20 54 H86 L83 59.5 Q82.5 61 80.5 61 H25.5 Q23.5 61 23 59.5 Z"
        className="fill-utility-brand-300"
      />
      <rect x="46" y="54" width="14" height="2" rx="1" className="fill-utility-brand-400" />
      <Mascot name="yellow" x={4} y={30} size={29} />
      <Mascot name="pink" x={74} y={30} size={27} />
    </svg>
  );
}

/** The dialog's two illustrations, one per kind of Agent. */
export const AGENT_ILLUSTRATIONS = {
  cloud: CloudAgentIllustration,
  local: LocalAgentIllustration,
} as const;
