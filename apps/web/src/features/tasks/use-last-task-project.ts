import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { loadTaskCreateDefaults } from "./tasks.functions";

/** The Project the viewer last filed a Task under in a conversation, offered first in a form's
 * Project picker. Null for none, or until it is read. */
export function useLastTaskProject(conversationId: string | undefined, open: boolean) {
  const load = useServerFn(loadTaskCreateDefaults);
  const defaults = useQuery({
    queryKey: ["task-create-defaults", conversationId],
    queryFn: () => load({ data: { conversationId: conversationId! } }),
    enabled: open && conversationId !== undefined,
    staleTime: 0,
  });
  return defaults.data?.project ?? null;
}
