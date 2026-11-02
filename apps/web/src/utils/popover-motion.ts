/**
 * How a popover React Aria positions comes and goes, written the way React Aria documents it
 * (https://react-aria.adobe.com/Popover): only its translate and opacity transition, from its
 * trigger's side, while `data-entering` / `data-exiting` hold the hidden state. Nothing else may
 * transition: as a popover enters, React Aria resets its top and max-height to measure it, and an
 * eased reset reads the old clipped height, so a menu short of room below would not flip above.
 */
export const POPOVER_MOTION = [
  "transition-[translate,opacity] duration-150 ease-out exiting:duration-100 exiting:ease-in",
  "entering:opacity-0 exiting:opacity-0",
  "placement-bottom:entering:-translate-y-0.5 placement-bottom:exiting:-translate-y-0.5",
  "placement-top:entering:translate-y-0.5 placement-top:exiting:translate-y-0.5",
  "placement-right:entering:-translate-x-0.5 placement-right:exiting:-translate-x-0.5",
  "placement-left:entering:translate-x-0.5 placement-left:exiting:translate-x-0.5",
].join(" ");
