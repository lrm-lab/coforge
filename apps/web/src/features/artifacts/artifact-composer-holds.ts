import { useContext, useEffect } from "react";

import { ArtifactCommentingContext } from "./artifact-commenting";

export type ComposerHolds = { hold(): () => void; any(): boolean };

export function createComposerHolds(): ComposerHolds {
  let count = 0;
  return {
    hold() {
      count += 1;
      return () => {
        count -= 1;
      };
    },
    any: () => count > 0,
  };
}

export function useHoldComposer(holding: boolean) {
  const holds = useContext(ArtifactCommentingContext)?.holds;
  useEffect(() => (holding ? holds?.hold() : undefined), [holding, holds]);
}
