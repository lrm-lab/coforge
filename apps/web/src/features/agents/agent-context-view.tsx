import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import {
  requestAgentContextView,
  resolveAgentContextViewTarget,
} from "./agent-context-view.functions";

type Props = {
  computerId: string;
  agentId: string;
  messageId: string;
  sessionId: string;
  maxBytes?: number;
};

/** Owner-visible action for a persisted Agent message. The host supplies the message's session. */
export function AgentContextView({
  computerId,
  agentId,
  messageId,
  sessionId,
  maxBytes = 32 * 1024 * 1024,
}: Props) {
  const request = useServerFn(requestAgentContextView);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [text, setText] = useState<string>();
  return (
    <div className="flex flex-col gap-2" data-agent-context-view>
      <Button
        size="sm"
        color="secondary"
        isDisabled={state === "loading"}
        onClick={async () => {
          setState("loading");
          setText(undefined);
          try {
            const result = await request({
              data: { computerId, agentId, messageId, sessionId, maxBytes },
            });
            if (result.status === "failed") {
              setState("failed");
              setText(`Context unavailable: ${result.result.reason ?? "read_failed"}`);
              return;
            }
            if (result.status !== "ready") {
              setState("failed");
              setText(`Context unavailable: ${result.status}`);
              return;
            }
            if (result.result.encoding !== "identity") {
              setState("failed");
              setText("Context unavailable: unsupported result encoding");
              return;
            }
            const bytes = result.result.content;
            setState("ready");
            setText(new TextDecoder().decode(bytes));
          } catch {
            setState("failed");
            setText("Context unavailable");
          }
        }}
      >
        {state === "loading" ? "Loading context…" : "View context"}
      </Button>
      {text && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm" role="status">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Profile entry that resolves the current session/message atomically before requesting a view. */
export function AgentContextViewForAgent({ agentId }: { agentId: string }) {
  const resolve = useServerFn(resolveAgentContextViewTarget);
  const [target, setTarget] =
    useState<
      Extract<Awaited<ReturnType<typeof resolveAgentContextViewTarget>>, { status: "ready" }>
    >();
  const [error, setError] = useState(false);
  return (
    <div className="mt-3">
      {!target ? (
        <Button
          size="sm"
          color="secondary"
          onClick={async () => {
            setError(false);
            try {
              const result = await resolve({ data: { agentId } });
              if (result.status === "ready") setTarget(result);
              else setError(true);
            } catch {
              setError(true);
            }
          }}
        >
          View context
        </Button>
      ) : (
        <AgentContextView {...target} />
      )}
      {error && (
        <p className="mt-1 text-xs text-tertiary" role="status">
          Context unavailable
        </p>
      )}
    </div>
  );
}
