import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { decideMachineAttach, type readMachineAttach } from "./machine-attach.functions";
import { MachineAttachRequests } from "./machine-attach-requests";
import { MachineAttachReason, MachineAttachStatus } from "./machine-attach-status";

type Session = NonNullable<Awaited<ReturnType<typeof readMachineAttach>>>;

export function MachineAttachApproval({
  sessionId,
  session,
}: {
  sessionId: string;
  session: Session;
}) {
  const router = useRouter();
  const sendDecision = useServerFn(decideMachineAttach);
  const [workspaceId, setWorkspaceId] = useState(session.workspaces[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  const effectiveStatus =
    session.status === "awaiting_approval" ? (status ?? session.status) : session.status;
  const pending = effectiveStatus === "awaiting_approval";
  const reason = effectiveStatus === "denied" ? "denied" : session.failureReason;

  const decide = async (action: "approve" | "deny") => {
    setFailed(false);
    setBusy(true);
    try {
      const result = await sendDecision({
        data: {
          sessionId,
          workspaceId,
          action,
          ...(action === "approve" ? { userCode: code.trim() } : {}),
        },
      });
      if (!result.accepted) {
        setFailed(true);
        return;
      }
      setStatus(action === "approve" ? "approved" : "denied");
      await router.invalidate();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-[71rem] min-w-0 flex-col gap-8 px-page py-8 md:flex-row md:items-start">
      {session.relatedRequests.length ? (
        <aside className="hidden min-w-0 flex-1 md:block">
          <MachineAttachRequests
            requests={session.relatedRequests}
            activeId={sessionId}
            updatedAt={renderedAt}
          />
        </aside>
      ) : null}
      <section className="mx-auto w-full min-w-0 max-w-md rounded-xl border border-secondary bg-primary p-5 md:flex-1">
        <h1 className="text-lg font-semibold text-primary">{m.computer_attach_approval_title()}</h1>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-tertiary">{m.computer_attach_machine()}</dt>
            <dd className="min-w-0 text-right wrap-anywhere text-primary">{session.machineName}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-tertiary">{m.computer_attach_hostname()}</dt>
            <dd className="min-w-0 text-right wrap-anywhere text-primary">{session.hostname}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-tertiary">{m.computer_attach_fingerprint()}</dt>
            <dd className="min-w-0 text-right font-mono wrap-anywhere text-primary">
              {session.fingerprint}
            </dd>
          </div>
        </dl>

        {pending ? (
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && workspaceId && code.trim().length === 8) void decide("approve");
            }}
          >
            <Select
              aria-label={m.computer_attach_workspace_label()}
              selectedKey={workspaceId}
              onSelectionChange={(key) => setWorkspaceId(String(key))}
              items={session.workspaces.map((workspace) => ({
                id: workspace.id,
                label: workspace.name,
              }))}
              isDisabled={busy || Boolean(session.targetWorkspaceId)}
            >
              {(workspace) => <Select.Item id={workspace.id} label={workspace.label} />}
            </Select>
            <Input
              label={m.computer_attach_code_label()}
              placeholder={m.computer_attach_code_placeholder()}
              hint={m.computer_attach_fingerprint_hint()}
              autoComplete="off"
              maxLength={8}
              value={code}
              onChange={setCode}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                color="secondary"
                className="min-h-11 flex-1"
                isDisabled={busy || !workspaceId}
                onPress={() => void decide("deny")}
              >
                {m.computer_attach_refuse()}
              </Button>
              <Button
                type="submit"
                color="primary"
                className="min-h-11 flex-1"
                isDisabled={busy || !workspaceId || code.trim().length !== 8}
              >
                {m.computer_attach_approve()}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 space-y-2" role="status">
            <MachineAttachStatus status={effectiveStatus} />
            <p className="text-sm text-tertiary">
              {reason ? (
                <MachineAttachReason reason={reason} />
              ) : effectiveStatus === "ready" ? (
                m.computer_attach_connected_confirmation()
              ) : (
                m.computer_attach_approved_continue()
              )}
            </p>
          </div>
        )}
        {failed ? (
          <p role="alert" className="mt-3 text-sm text-error-primary">
            {m.computer_attach_failed()}
          </p>
        ) : null}
      </section>
    </main>
  );
}
