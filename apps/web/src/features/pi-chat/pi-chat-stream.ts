import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";

/** Use the shared browser connection; native cursors reconcile reads against in-flight live events. */
export function usePiChatStream(scope: PiChatScope, workspaceSlug: string, sessionId: string) {
  const queries = useQueryClient();
  const live = useRef(new PiChatLiveHistory(sessionId));
  const assemblies = useRef(new Map<string, PiChatFrameAssembly>());
  const queryKey = ["pi-chat", workspaceSlug, scope.computerId, "session", sessionId];
  const listKey = ["pi-chat", workspaceSlug, scope.computerId, "sessions"];
  const recover = () => {
    void queries.invalidateQueries({ queryKey });
    void queries.invalidateQueries({ queryKey: listKey });
  };
  useRealtimeSubscription({
    channel: userConversationChannel(scope.userId),
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
          if (entry.isIdle(now)) {
            assemblies.current.delete(id);
            recover();
          }
        let assembly = assemblies.current.get(frame.frameId);
        if (!assembly) {
          if (assemblies.current.size >= 4) {
            assemblies.current.clear();
            recover();
          }
          assembly = new PiChatFrameAssembly();
          assemblies.current.set(frame.frameId, assembly);
        }
        const value = assembly.accept(frame, now);
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
        if (event.sessionId === sessionId)
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
  return useCallback((read: () => Promise<PiChatResult>) => live.current.read(read), []);
}
