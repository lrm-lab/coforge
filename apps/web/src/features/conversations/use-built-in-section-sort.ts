import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_BUILT_IN_SORT_MODES,
  readBuiltInSectionSortModes,
  writeBuiltInSectionSortModes,
  type BuiltInSectionId,
  type BuiltInSectionSortModes,
} from "./directory-sections";

export function useBuiltInSectionSortModes() {
  const [sortModes, setSortModes] = useState<BuiltInSectionSortModes>(DEFAULT_BUILT_IN_SORT_MODES);

  useEffect(() => setSortModes(readBuiltInSectionSortModes()), []);

  const setSortMode = useCallback(
    <Section extends BuiltInSectionId>(
      section: Section,
      mode: BuiltInSectionSortModes[Section],
    ) => {
      setSortModes((current) => {
        if (current[section] === mode) return current;
        const next = { ...current, [section]: mode };
        writeBuiltInSectionSortModes(next);
        return next;
      });
    },
    [],
  );

  return { sortModes, setSortMode };
}
