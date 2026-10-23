import { useMediaQuery } from "./use-media-query";

/**
 * Whether the user asked the system for less motion. The server render (and the hydrating one)
 * answer yes, so the markup they send holds the still picture a motion-averse browser keeps; a
 * browser that allows motion renders again after hydration.
 */
export const usePrefersReducedMotion = () =>
  useMediaQuery("(prefers-reduced-motion: reduce)", true);
