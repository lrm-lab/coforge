import { useMatches } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    standalone?: boolean;
  }
}

export function useIsStandalonePage(): boolean {
  return useMatches({
    select: (matches) => matches.some((match) => match.staticData.standalone === true),
  });
}
