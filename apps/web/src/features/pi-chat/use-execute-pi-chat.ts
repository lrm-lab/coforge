import { useServerFn } from "@tanstack/react-start";
import { executePiChat } from "./pi-chat.functions";

/** `executePiChat` for the Workbench page. */
export function useExecutePiChat() {
  return useServerFn(executePiChat);
}
