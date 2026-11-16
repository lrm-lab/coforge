import type { AgentSession } from "@coforge/agent";
import { buildStartupMemoryBlock } from "./startup-memory-block";

export function withMemoryRecovery(session: AgentSession, directory: string): AgentSession {
  let pending = false;
  let waiting = 0;
  let preparation = Promise.resolve();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction-finished") pending = true;
  });
  const offExit = session.onExit(() => unsubscribe());
  const wrap =
    (original: (text: string, ...args: never[]) => Promise<void>) =>
    (text: string, ...args: never[]): Promise<void> => {
      if (!pending && waiting === 0) return original.call(session, text, ...args);
      waiting++;
      const started = preparation.then(async () => {
        const restore = pending;
        pending = false;
        if (restore) {
          const block = await buildStartupMemoryBlock({
            agentWorkspaceDirectory: directory,
            budgetTokens: 1_000,
          }).catch(() => undefined);
          if (block)
            text = `${block.text}\n\nMemory is historical reference; current instructions and verified state take precedence.\n\n${text}`;
        }
        try {
          return { result: original.call(session, text, ...args), restore };
        } catch (error) {
          if (restore) pending = true;
          throw error;
        }
      });
      preparation = started.then(
        () => {
          waiting--;
        },
        () => {
          waiting--;
        },
      );
      return started.then(async ({ result, restore }) => {
        try {
          await result;
        } catch (error) {
          if (restore) pending = true;
          throw error;
        }
      });
    };
  session.sendMessage = wrap(session.sendMessage);
  if (session.notify) session.notify = wrap(session.notify);
  const dispose = session.dispose;
  session.dispose = async () => {
    await dispose.call(session);
    unsubscribe();
    offExit();
  };
  return session;
}
