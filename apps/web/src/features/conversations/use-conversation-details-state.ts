import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "@tanstack/react-router";

import { useConversationFocus } from "./conversation-focus";

type SideSlotSearch = {
  threadRootId?: string;
  profile?: string;
  agentTab?: unknown;
};

export function useConversationDetailsState({
  controlledOpen,
  onControlledOpenChange,
  requestCloseRef: controlledRequestCloseRef,
}: {
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
  requestCloseRef?: MutableRefObject<((then?: () => void) => void) | null>;
} = {}) {
  const router = useRouter();
  const focus = useConversationFocus();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = onControlledOpenChange ?? setOwnOpen;
  const ownRequestCloseRef = useRef<((then?: () => void) => void) | null>(null);
  const requestCloseRef = controlledRequestCloseRef ?? ownRequestCloseRef;

  const openDetails = useCallback(() => {
    if (focus?.focused === "chat") focus.toggle("chat");
    setOpen(true);
    void router.navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      search: (previous: SideSlotSearch) => {
        if (
          previous.threadRootId === undefined &&
          previous.profile === undefined &&
          previous.agentTab === undefined
        ) {
          return previous;
        }
        const { threadRootId: _t, profile: _p, agentTab: _a, ...rest } = previous;
        return rest;
      },
    });
  }, [focus, router, setOpen]);

  const requestClose = useCallback(
    (then?: () => void) => {
      if (requestCloseRef.current) {
        requestCloseRef.current(then);
        return;
      }
      setOpen(false);
      then?.();
    },
    [setOpen],
  );

  return {
    open,
    setOpen,
    openDetails,
    requestClose,
    requestCloseRef,
  };
}
