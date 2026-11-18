/**
 * How a popover React Aria positions comes and goes, written the way React Aria documents it
 * (https://react-aria.adobe.com/Popover): it grows out of its trigger (scale from 96% about
 * `--trigger-anchor-point`, which every popover sets as its origin) with a 2px slide from the
 * trigger's side and a fade, while `data-entering` / `data-exiting` hold the hidden state. With
 * reduced motion it only fades. Nothing else may transition: as a popover enters, React Aria resets
 * its top and max-height to measure it, and an eased reset reads the old clipped height, so a menu
 * short of room below would not flip above. Scale is safe: React Aria sizes the overlay from
 * offsetWidth/offsetHeight, which a transform does not change.
 */
export const POPOVER_MOTION = [
  "transition-[translate,scale,opacity] motion-enter-sm exiting:motion-leave-sm",
  "entering:opacity-0 exiting:opacity-0",
  "entering:scale-[0.96] exiting:scale-[0.96] motion-reduce:entering:scale-100 motion-reduce:exiting:scale-100",
  "placement-bottom:entering:-translate-y-0.5 placement-bottom:exiting:-translate-y-0.5",
  "placement-top:entering:translate-y-0.5 placement-top:exiting:translate-y-0.5",
  "placement-right:entering:-translate-x-0.5 placement-right:exiting:-translate-x-0.5",
  "placement-left:entering:translate-x-0.5 placement-left:exiting:translate-x-0.5",
].join(" ");
