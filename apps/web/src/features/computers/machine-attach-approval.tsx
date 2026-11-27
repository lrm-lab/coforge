import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { useAppForm } from "#src/components/ui/form";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
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
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renderedAt] = useState(() => Date.now());
  const effectiveStatus =
    session.status === "awaiting_approval" ? (status ?? session.status) : session.status;
  const pending = effectiveStatus === "awaiting_approval";
  const reason = effectiveStatus === "denied" ? "denied" : session.failureReason;

  const decide = async (action: "approve" | "deny", workspaceId: string, code: string) => {
    setError("");
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
        setError(m.computer_attach_failed());
        return;
      }
      setStatus(action === "approve" ? "approved" : "denied");
      await router.invalidate();
    } catch {
      setError(m.computer_attach_failed());
    } finally {
      setBusy(false);
    }
  };

  const form = useAppForm({
    defaultValues: {
      workspaceId: session.workspaces[0]?.id ?? "",
      code: "",
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (busy || !value.workspaceId || value.code.trim().length !== 8) return;
      await decide("approve", value.workspaceId, value.code);
    },
  });

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

        <form.AppForm>
          {pending ? (
            <form
              ref={formRef}
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.AppField name="workspaceId">
                {(field) => (
                  <field.Select
                    aria-label={m.computer_attach_workspace_label()}
                    items={session.workspaces.map((workspace) => ({
                      id: workspace.id,
                      label: workspace.name,
                    }))}
                    isDisabled={busy || Boolean(session.targetWorkspaceId)}
                  >
                    {(workspace) => <Select.Item id={workspace.id} label={workspace.label} />}
                  </field.Select>
                )}
              </form.AppField>
              <form.AppField name="code">
                {(field) => (
                  <field.Input
                    label={m.computer_attach_code_label()}
                    placeholder={m.computer_attach_code_placeholder()}
                    hint={m.computer_attach_fingerprint_hint()}
                    autoComplete="off"
                    maxLength={8}
                  />
                )}
              </form.AppField>
              <form.Subscribe
                selector={(state) => ({
                  workspaceId: state.values.workspaceId,
                  code: state.values.code,
                })}
              >
                {({ workspaceId, code }) => (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      color="secondary"
                      className="min-h-11 flex-1"
                      isDisabled={busy || !workspaceId}
                      onPress={() => void decide("deny", workspaceId, "")}
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
                )}
              </form.Subscribe>
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
          <form.Alert error={error} className="mt-3 text-sm text-error-primary" />
        </form.AppForm>
      </section>
    </main>
  );
}
