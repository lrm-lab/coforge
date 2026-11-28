import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display-xs", "display-sm", "display-md", "display-lg", "display-xl", "display-2xl"],
      spacing: ["page", "pane-header", "pane-subbar"],
      shadow: [
        "skeuomorphic",
        "xs-skeuomorphic",
        "modern-mockup-inner-sm",
        "modern-mockup-inner-md",
        "modern-mockup-inner-lg",
        "modern-mockup-outer-md",
        "modern-mockup-outer-lg",
      ],
      ease: ["out-strong", "overshoot", "spring"],
    },
  },
});

export const cx = twMerge;

export function sortCx<
  T extends Record<
    string,
    string | number | Record<string, string | number | Record<string, string | number>>
  >,
>(classes: T): T {
  return classes;
}
