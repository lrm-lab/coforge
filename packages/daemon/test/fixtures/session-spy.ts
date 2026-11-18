import type { AgentSession } from "@lrm/coforge-anvil";

type ExitListener = Parameters<AgentSession["onExit"]>[0];

export function sessionSpy() {
  const exits = new Set<ExitListener>();
  const session = {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit(listener: ExitListener) {
      exits.add(listener);
      return () => void exits.delete(listener);
    },
    async dispose() {},
  } satisfies AgentSession;
  return {
    ...session,
    exit() {
      for (const listener of exits) listener();
      exits.clear();
    },
  };
}
