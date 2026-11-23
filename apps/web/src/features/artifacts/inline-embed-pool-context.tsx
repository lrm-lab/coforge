import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";

import {
  INLINE_EMBED_MAX_ACTIVE,
  createInlineEmbedPool,
  type InlineEmbedPool,
} from "./inline-embed-pool";

const InlineEmbedPoolContext = createContext<InlineEmbedPool | null>(null);

export function InlineEmbedPoolProvider({
  scopeKey,
  maxActive = INLINE_EMBED_MAX_ACTIVE,
  children,
}: {
  scopeKey: string;
  maxActive?: number;
  children: ReactNode;
}) {
  const pool = useMemo(() => createInlineEmbedPool(maxActive), [scopeKey, maxActive]);
  const parkingRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      pool.setParkingContainer(node);
      return () => {
        pool.setParkingContainer(null);
      };
    },
    [pool],
  );
  useEffect(() => () => pool.dispose(), [pool]);

  return (
    <InlineEmbedPoolContext value={pool}>
      <div
        key={scopeKey}
        ref={parkingRef}
        hidden
        inert
        aria-hidden="true"
        data-inline-embed-parking=""
        className="hidden"
      />
      {children}
    </InlineEmbedPoolContext>
  );
}

export function useOptionalInlineEmbedPool(): InlineEmbedPool | null {
  return useContext(InlineEmbedPoolContext);
}

export function useInlineEmbedPool(): InlineEmbedPool {
  const provided = useContext(InlineEmbedPoolContext);
  const local = useMemo(() => (provided ? null : createInlineEmbedPool(1)), [provided]);
  return provided ?? local!;
}
