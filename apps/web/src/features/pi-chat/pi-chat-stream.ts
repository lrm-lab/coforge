import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  piChatEventSchema,
  type PiChatResult,
  type PiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat";
import {
  decodePiChatFrame,
  PiChatFrameAssembly,
  samePiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { PiChatLiveHistory, applyPiChatEvent } from "@lrm/coforge-sdk/internal/pi-chat-stream";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getUserConversationSubscriptionToken } from "#src/features/realtime/realtime.functions";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";

/** Use the shared browser connection; native cursors reconcile reads against in-flight live events. */
export function usePiChatStream(scope: PiChatScope, workspaceSlug: string, sessionId: string) {
  const queries = useQueryClient();
  const getToken = useServerFn(getUserConversationSubscriptionToken);
  const live = useRef(new PiChatLiveHistory(sessionId));
  const assemblies = useRef(new Map<string, { at: number; value: PiChatFrameAssembly }>());
  const queryKey = ["pi-chat", workspaceSlug, scope.computerId, "session", sessionId];
  const listKey = ["pi-chat", workspaceSlug, scope.computerId, "sessions"];
  const recover = () => {
    void queries.invalidateQueries({ queryKey });
    void queries.invalidateQueries({ queryKey: listKey });
  };
  useRealtimeSubscription({
    channel: userConversationChannel(scope.userId),
    getToken,
    onSubscribed: recover,
    onError: recover,
    onPublication: ({ data }) => {
      if (!(data instanceof Uint8Array)) return;
      let frame;
      try {
        frame = decodePiChatFrame(data);
      } catch {
        return;
      } // Other private user-channel event types.
      if (frame.kind !== "event" || !samePiChatScope(frame, scope)) return;
      try {
        const now = Date.now();
        for (const [id, entry] of assemblies.current)
          if (now - entry.at > 5000) {
            assemblies.current.delete(id);
            recover();
          }
        let assembly = assemblies.current.get(frame.frameId);
        if (!assembly) {
          if (assemblies.current.size >= 4) {
            assemblies.current.clear();
            recover();
          }
          assembly = { at: now, value: new PiChatFrameAssembly() };
          assemblies.current.set(frame.frameId, assembly);
        }
        const value = assembly.value.accept(frame);
        if (!value) return;
        assemblies.current.delete(frame.frameId);
        const event = piChatEventSchema.parse(value);
        const outcome = live.current.accept(event);
        if (outcome === "ignored") return;
        if (event.session || event.deleted)
          queries.setQueryData<PiChatResult>(listKey, (current) => {
            if (!current?.sessions) return current;
            const rows = current.sessions.filter((row) => row.id !== event.sessionId);
            if (event.session && !event.deleted) rows.push(event.session);
            return { ...current, sessions: rows.sort((a, b) => b.updatedAt - a.updatedAt) };
          });
        if (event.sessionId === sessionId && outcome !== "ignored")
          queries.setQueryData<PiChatResult>(queryKey, (current) =>
            current ? applyPiChatEvent(current, event) : current,
          );
        if (outcome === "recover" || event.deleted) recover();
      } catch {
        assemblies.current.delete(frame.frameId);
        recover();
      }
    },
  });
  return useCallback((snapshot: PiChatResult) => live.current.merge(snapshot), []);
}
