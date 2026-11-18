export const POPOVER_MOTION = [
  "transition-[translate,scale,opacity] motion-enter-sm exiting:motion-leave-sm",
  "entering:opacity-0 exiting:opacity-0",
  "entering:scale-[0.96] exiting:scale-[0.96] motion-reduce:entering:scale-100 motion-reduce:exiting:scale-100",
  "placement-bottom:entering:-translate-y-0.5 placement-bottom:exiting:-translate-y-0.5",
  "placement-top:entering:translate-y-0.5 placement-top:exiting:translate-y-0.5",
  "placement-right:entering:-translate-x-0.5 placement-right:exiting:-translate-x-0.5",
  "placement-left:entering:translate-x-0.5 placement-left:exiting:translate-x-0.5",
].join(" ");
