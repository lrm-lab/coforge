import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import { useContext, useState, type ReactNode } from "react";
import { OverlayTriggerStateContext } from "react-aria-components";
import { LogIn01, LogOut01 } from "@untitledui/icons";
import { RUNTIME_AUTH_PROVIDERS, type RuntimeAuthProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail";
import { computerLabel } from "./computer-identity";
import { RuntimeChip } from "./runtime-chip";
import { RuntimeSignInDialog, unsupportedText } from "./runtime-sign-in-dialog";
import { RuntimeSignOutDialog } from "./runtime-sign-out-dialog";
import { RuntimeUsage } from "./runtime-usage";

const RUNTIME_CHIP_TRIGGER_CLASS_NAME =
  "rounded-md outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

function isAuthProvider(provider: string): provider is RuntimeAuthProvider {
  return (RUNTIME_AUTH_PROVIDERS as readonly string[]).includes(provider);
}

type AuthDialog = { kind: "sign_in" | "sign_out"; provider: RuntimeAuthProvider; name: string };

/**
 * A Computer's runtimes as Raft lays them out: one chip each, opening that runtime's popover on a
 * press. The owner's popover carries usage and the Public switch; anyone else's opens only for a
 * runtime with a login state, to show that state and, for Workspace owners and admins, the account.
 * Those who may sign a runtime in or out (the server's rule: the Computer's owner, or a Workspace
 * owner or admin) get Sign in or Sign out there too.
 */
export function ComputerRuntimeList({
  computer,
  timeZone,
  onSetRuntimePublic,
}: {
  computer: Pick<
    ComputerDetailView,
    | "id"
    | "name"
    | "displayName"
    | "kind"
    | "platform"
    | "online"
    | "ownedByCurrentUser"
    | "canManageAgents"
    | "runtimeAuth"
    | "runtimes"
    | "agents"
  >;
  timeZone: string | null;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
}) {
  const [updatingRuntimeIds, setUpdatingRuntimeIds] = useState<ReadonlySet<string>>(new Set());
  const [runtimeVisibilityErrorIds, setRuntimeVisibilityErrorIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [authDialog, setAuthDialog] = useState<AuthDialog | undefined>(undefined);
  const canSignIn = computer.ownedByCurrentUser || computer.canManageAgents;
  const computerName = computerLabel(computer);
  const setRuntimePublic = async (runtimeId: string, isPublic: boolean) => {
    const without = (ids: ReadonlySet<string>) =>
      new Set([...ids].filter((id) => id !== runtimeId));
    setUpdatingRuntimeIds((ids) => new Set(ids).add(runtimeId));
    setRuntimeVisibilityErrorIds(without);
    try {
      await onSetRuntimePublic(runtimeId, isPublic);
    } catch {
      setRuntimeVisibilityErrorIds((ids) => new Set(ids).add(runtimeId));
    } finally {
      setUpdatingRuntimeIds(without);
    }
  };

  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {computer.runtimes.map((runtime) => {
          const provider = runtime.provider;
          const auth = isAuthProvider(provider) ? computer.runtimeAuth?.[provider] : undefined;
          const signable = canSignIn && isAuthProvider(provider);
          const open = (kind: AuthDialog["kind"]) =>
            isAuthProvider(provider) &&
            setAuthDialog({ kind, provider, name: runtime.displayName });
          const signIn =
            signable &&
            auth?.state === "logged_out" &&
            (provider !== RUNTIME_PROVIDER.KIRO || computer.platform !== "win32");
          const signOut = signable && auth?.state === "logged_in";
          // One button in one place, signed in or out: the account band's own action.
          const accountAction = (signIn || signOut) && (
            <PopoverAction onPress={() => open(signIn ? "sign_in" : "sign_out")}>
              {(press) => (
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={signIn ? LogIn01 : LogOut01}
                  className="shrink-0"
                  onPress={press}
                >
                  {signIn ? m.runtime_auth_sign_in() : m.runtime_auth_sign_out()}
                </Button>
              )}
            </PopoverAction>
          );
          const unavailable = auth?.state === "unavailable" && auth.unavailableReason && (
            <p key="account" className="px-4 py-3 text-sm text-tertiary">
              {unsupportedText(auth.unavailableReason, runtime.displayName)}
            </p>
          );
          const visibility = computer.ownedByCurrentUser && (
            <div key="public" className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-secondary">
                  {m.computer_runtime_public()}
                </span>
                {/* A disabled toggle drops focus to the page mid-press (task #116; the
                    refresh bug #179 went down this exact path). Repeat edits are ignored
                    in the handler instead; the error text below still reports a failed
                    change. */}
                <Toggle
                  size="sm"
                  aria-label={m.computer_runtime_public()}
                  isSelected={runtime.isPublic}
                  aria-busy={updatingRuntimeIds.has(runtime.id) || undefined}
                  onChange={(isPublic) => {
                    if (!updatingRuntimeIds.has(runtime.id))
                      void setRuntimePublic(runtime.id, isPublic);
                  }}
                />
              </div>
              {runtimeVisibilityErrorIds.has(runtime.id) && (
                <p role="alert" className="mt-2 text-xs text-error-primary">
                  {m.computer_runtime_visibility_error()}
                </p>
              )}
            </div>
          );
          return (
            <li key={provider}>
              <RuntimeUsage
                computerId={computer.id}
                runtime={runtime}
                computerOnline={computer.online}
                timeZone={timeZone}
                showUsage={computer.ownedByCurrentUser}
                auth={auth}
                triggerClassName={RUNTIME_CHIP_TRIGGER_CLASS_NAME}
                trigger={(health) => <RuntimeChip runtime={runtime} auth={auth} health={health} />}
                actions={(visibility || unavailable) && [visibility, unavailable]}
                accountAction={accountAction || undefined}
              />
            </li>
          );
        })}
      </ul>
      {authDialog?.kind === "sign_in" && (
        <RuntimeSignInDialog
          computerId={computer.id}
          computerName={computerName}
          provider={authDialog.provider}
          runtimeName={authDialog.name}
          onClose={() => setAuthDialog(undefined)}
        />
      )}
      {authDialog?.kind === "sign_out" && (
        <RuntimeSignOutDialog
          computerId={computer.id}
          computerName={computerName}
          provider={authDialog.provider}
          runtimeName={authDialog.name}
          agentNames={computer.agents
            .filter((agent) => agent.provider === authDialog.provider)
            .map((agent) => agent.displayName || agent.name)}
          onClose={() => setAuthDialog(undefined)}
        />
      )}
    </>
  );
}

/** An action inside the runtime popover that opens a dialog: the popover closes first, so the
 * dialog is the only thing over the page. */
function PopoverAction({
  onPress,
  children,
}: {
  onPress: () => void;
  children: (press: () => void) => ReactNode;
}) {
  const popover = useContext(OverlayTriggerStateContext);
  return children(() => {
    popover?.close();
    onPress();
  });
}
