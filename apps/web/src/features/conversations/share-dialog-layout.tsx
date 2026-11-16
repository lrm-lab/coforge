import type { ReactNode } from "react";

import { WhatArrives } from "./message-forward-panes";

export type ShareLayout = {
  modalClassName: string;
  composerClassName?: string;
  targetStatus?: (selectedCount: number) => ReactNode;
  arrives: (what: { summary: ReactNode; preview: ReactNode }) => ReactNode;
  arrange: (panes: { target: ReactNode; composer: ReactNode }) => ReactNode;
};

export const stackedShareLayout: ShareLayout = {
  modalClassName: "sm:max-w-lg",
  arrives: ({ summary, preview }) => <WhatArrives summary={summary} preview={preview} />,
  arrange: ({ target, composer }) => (
    <>
      <div className="flex min-h-24 flex-1 flex-col sm:flex-[0_1_20rem]">{target}</div>
      {composer}
    </>
  ),
};
