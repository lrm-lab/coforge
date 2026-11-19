export const POPOVER_MOTION = [
  "coforge-popover",
  "transition-[translate,scale,opacity] duration-(--duration-sm) max-lg:duration-(--duration-md) ease-out",
  "exiting:duration-(--duration-sm-out) max-lg:exiting:duration-(--duration-md-out) exiting:ease-in",
  "entering:opacity-0 exiting:opacity-0",
  "entering:scale-[0.88] exiting:scale-[0.92]",
  "motion-reduce:duration-150 motion-reduce:entering:scale-100 motion-reduce:exiting:scale-100",
  "placement-bottom:entering:-translate-y-1 placement-bottom:exiting:-translate-y-0.5",
  "placement-top:entering:translate-y-1 placement-top:exiting:translate-y-0.5",
  "placement-right:entering:-translate-x-1 placement-right:exiting:-translate-x-0.5",
  "placement-left:entering:translate-x-1 placement-left:exiting:translate-x-0.5",
].join(" ");
