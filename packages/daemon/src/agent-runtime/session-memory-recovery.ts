import type { AgentSession } from "@coforge/agent";
import { buildStartupMemoryBlock } from "./startup-memory-block";

export function withMemoryRecovery(session: AgentSession, directory: string): AgentSession {
  let pending = false;
  let preparation = Promise.resolve();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction-finished") pending = true;
  });
  const offExit = session.onExit(() => unsubscribe());
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(session, {
    get(target, property) {
      if (methods.has(property)) return methods.get(property);
      const original = Reflect.get(target, property, target);
      if (typeof original !== "function") return original;
      let method: unknown;
      if (property === "sendMessage" || property === "notify") {
        method = (text: string, ...args: unknown[]) => {
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
              return {
                result: Reflect.apply(original, target, [text, ...args]) as Promise<void>,
                restore,
              };
            } catch (error) {
              if (restore) pending = true;
              throw error;
            }
          });
          preparation = started.then(
            () => {},
            () => {},
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
      } else if (property === "dispose") {
        method = (...args: unknown[]) => {
          unsubscribe();
          offExit();
          return Reflect.apply(original, target, args);
        };
      } else method = original.bind(target);
      methods.set(property, method);
      return method;
    },
  });
}
