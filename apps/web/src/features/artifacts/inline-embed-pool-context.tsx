import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  INLINE_EMBED_MAX_ACTIVE,
  createInlineEmbedPool,
  type InlineEmbedPool,
} from "./inline-embed-pool";

const InlineEmbedPoolContext = createContext<InlineEmbedPool | null>(null);

export function InlineEmbedPoolProvider({
  conversationKey,
  maxActive = INLINE_EMBED_MAX_ACTIVE,
  children,
}: {
  conversationKey: string;
  maxActive?: number;
  children: ReactNode;
}) {
  const pool = useMemo(() => createInlineEmbedPool(maxActive), [conversationKey, maxActive]);
  return <InlineEmbedPoolContext value={pool}>{children}</InlineEmbedPoolContext>;
}

export function useInlineEmbedPool(): InlineEmbedPool {
  const provided = useContext(InlineEmbedPoolContext);
  const local = useMemo(() => (provided ? null : createInlineEmbedPool(1)), [provided]);
  return provided ?? local!;
}
