import { useState } from "react";
import type { RuntimeAuthProvider } from "@lrm/coforge-anvil";

import { Toggle } from "#src/components/base/toggle/toggle";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail";
import { RuntimeChip } from "./runtime-chip";
import { RuntimeUsage } from "./runtime-usage";

const RUNTIME_CHIP_TRIGGER_CLASS_NAME =
  "rounded-md outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

/**
 * A Computer's runtimes as Raft lays them out: one chip each, opening that runtime's popover on a
 * press. The owner's popover carries usage and the Public switch; anyone else's opens only for a
 * runtime with a login state, to show that state and, for Workspace owners and admins, the account.
 */
export function ComputerRuntimeList({
  computer,
  timeZone,
  onSetRuntimePublic,
}: {
  computer: Pick<
    ComputerDetailView,
    "id" | "online" | "ownedByCurrentUser" | "runtimeAuth" | "runtimes"
  >;
  timeZone: string | null;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
}) {
  const [updatingRuntimeIds, setUpdatingRuntimeIds] = useState<ReadonlySet<string>>(new Set());
  const [runtimeVisibilityErrorIds, setRuntimeVisibilityErrorIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
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
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {computer.runtimes.map((runtime) => {
        const auth = computer.runtimeAuth?.[runtime.provider as RuntimeAuthProvider];
        return (
          <li key={runtime.provider}>
            <RuntimeUsage
              computerId={computer.id}
              runtime={runtime}
              computerOnline={computer.online}
              timeZone={timeZone}
              showUsage={computer.ownedByCurrentUser}
              auth={auth}
              triggerClassName={RUNTIME_CHIP_TRIGGER_CLASS_NAME}
              trigger={(health) => <RuntimeChip runtime={runtime} auth={auth} health={health} />}
              footer={
                computer.ownedByCurrentUser && (
                  <>
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
                  </>
                )
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
