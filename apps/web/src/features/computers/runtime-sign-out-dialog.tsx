import { useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeAuthLogoutResult, RuntimeAuthProvider } from "@lrm/coforge-sdk/internal";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { logoutRuntimeAuth, readRuntimeAuthLogout } from "./runtime-auth.functions";
import { unsupportedText } from "./runtime-sign-in-dialog";
import { useRuntimeAuthSignals } from "./use-runtime-auth-signals";

/** Past the daemon's own 60 s logout limit, which reports `timed_out` itself; this only keeps the
 * dialog from waiting forever on a report that never comes. */
const LOGOUT_WAIT_MS = 90_000;

/** Names at most three Agents, as Raft does, and counts the rest. */
export function affectedAgents(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length <= 3) return names.join(", ");
  return m.runtime_auth_agents_more({
    names: names.slice(0, 3).join(", "),
    count: String(names.length - 3),
  });
}

class SignOutRefused extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

/**
 * Signs a Computer's runtime out after a confirmation that names the Agents on that Computer
 * using it. The result comes back on the viewer's own channel; a (re)subscribe reads it once.
 */
export function RuntimeSignOutDialog({
  computerId,
  computerName,
  provider,
  runtimeName,
  agentNames,
  onClose,
}: {
  computerId: string;
  computerName: string;
  provider: RuntimeAuthProvider;
  runtimeName: string;
  agentNames: readonly string[];
  onClose: () => void;
}) {
  const logout = useServerFn(logoutRuntimeAuth);
  const read = useServerFn(readRuntimeAuthLogout);
  const waiting = useRef<
    { requestId: string; settle: (result: RuntimeAuthLogoutResult) => void } | undefined
  >(undefined);

  const settle = (view: { requestId: string; result?: RuntimeAuthLogoutResult }) => {
    const current = waiting.current;
    if (!current || view.requestId !== current.requestId || !view.result) return;
    waiting.current = undefined;
    current.settle(view.result);
  };
  const catchUp = () => {
    const current = waiting.current;
    if (!current) return;
    void read({ data: { computerId, requestId: current.requestId } })
      .then((view) => view && settle(view))
      .catch(() => {});
  };
  useRuntimeAuthSignals(computerId, {
    onSubscribed: catchUp,
    onSignal: (signal) => {
      if (signal.type === "runtime-auth.logout.v1") settle(signal);
    },
  });

  const agents = affectedAgents(agentNames);
  const body = m.runtime_auth_sign_out_body({ runtime: runtimeName, computer: computerName });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.runtime_auth_sign_out_title({ runtime: runtimeName })}
      description={agents ? `${body} ${m.runtime_auth_sign_out_agents({ agents })}` : body}
      confirmLabel={m.runtime_auth_sign_out()}
      pendingLabel={m.runtime_auth_signing_out()}
      errorMessage={(cause) =>
        cause instanceof SignOutRefused
          ? cause.text
          : m.runtime_auth_sign_out_failed({ runtime: runtimeName })
      }
      onConfirm={async () => {
        const requestId = crypto.randomUUID();
        const result = new Promise<RuntimeAuthLogoutResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiting.current = undefined;
            reject(new SignOutRefused(m.runtime_auth_sign_out_timed_out()));
          }, LOGOUT_WAIT_MS);
          waiting.current = {
            requestId,
            settle: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          };
        });
        const started = await logout({ data: { computerId, provider, requestId } });
        if ("status" in started) {
          waiting.current = undefined;
          throw new SignOutRefused(
            started.status === "offline"
              ? m.runtime_auth_failed_offline()
              : m.runtime_auth_failed_needs_upgrade(),
          );
        }
        if (started.result) settle(started);
        else catchUp();
        const outcome = await result;
        if (outcome.kind === "logged_out") {
          onClose();
          return;
        }
        throw new SignOutRefused(
          outcome.kind === "unsupported"
            ? unsupportedText(outcome.reason, runtimeName)
            : outcome.reason === "still_logged_in"
              ? outcome.detail === "command_code_api_key_env"
                ? m.runtime_auth_command_code_api_key_env()
                : m.runtime_auth_sign_out_still()
              : outcome.reason === "timed_out"
                ? m.runtime_auth_sign_out_timed_out()
                : m.runtime_auth_sign_out_failed({ runtime: runtimeName }),
        );
      }}
    />
  );
}
