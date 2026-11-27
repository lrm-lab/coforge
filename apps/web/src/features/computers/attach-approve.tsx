import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { CheckCircle, SlashCircle01 } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { EmptyState } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { KeyValueList, KeyValueRow } from "#src/components/ui/key-value-list";
import {
  approveComputerAttach,
  refuseComputerAttach,
} from "#src/features/computers/attach-approve.functions";
import { ErrorPageFrame } from "#src/features/errors/error-page-frame";
import { m } from "#src/paraglide/messages";

export function AttachApprovePage({
  sessionId,
  machineName,
  hostname,
  os,
  userCode,
  workspaces,
}: {
  sessionId: string;
  machineName: string;
  hostname: string;
  os: string;
  userCode: string;
  workspaces: { id: string; slug: string }[];
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [state, setState] = useState<"idle" | "done" | "refused" | "failed">("idle");
  const navigate = useNavigate();

  const decide = async (approve: boolean) => {
    setState("idle");
    try {
      if (approve) {
        const { approved } = await approveComputerAttach({
          data: { sessionId, workspaceId },
        });
        setState(approved ? "done" : "failed");
      } else {
        const { refused } = await refuseComputerAttach({ data: { sessionId } });
        setState(refused ? "refused" : "failed");
      }
    } catch {
      setState("failed");
    }
  };

  if (state === "done")
    return (
      <ErrorPageFrame>
        <EmptyState
          size="page"
          headingLevel={1}
          picture={<EmptyIcon icon={CheckCircle} muted />}
          title={m.empty_attach_done_title()}
          description={m.empty_attach_done_description({ machineName })}
        />
      </ErrorPageFrame>
    );
  if (state === "refused")
    return (
      <ErrorPageFrame>
        <EmptyState
          size="page"
          headingLevel={1}
          picture={<EmptyIcon icon={SlashCircle01} muted />}
          title={m.empty_attach_refused_title()}
          description={m.empty_attach_refused_description()}
        />
      </ErrorPageFrame>
    );

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">{m.computer_attach_title()}</h1>
      <p className="mt-2 text-sm text-secondary">{m.computer_attach_description()}</p>
      <KeyValueList className="mt-6" labelWidth="default">
        <KeyValueRow label={m.computer_attach_machine()}>{machineName}</KeyValueRow>
        <KeyValueRow label={m.computer_attach_hostname()}>{hostname}</KeyValueRow>
        <KeyValueRow label={m.computer_os()}>{os}</KeyValueRow>
      </KeyValueList>
      <p dir="ltr" className="mt-6 text-center font-mono text-2xl font-semibold tracking-widest">
        {userCode}
      </p>
      <p className="mt-1 text-center text-xs text-secondary">{m.computer_attach_confirm_code()}</p>
      <div className="mt-6">
        <Select
          aria-label={m.computer_attach_workspace_label()}
          selectedKey={workspaceId}
          onSelectionChange={(key) => setWorkspaceId(String(key))}
          items={workspaces.map((workspace) => ({ id: workspace.id, label: workspace.slug }))}
        >
          {(workspace) => <Select.Item id={workspace.id} label={workspace.label} />}
        </Select>
      </div>
      {state === "failed" && (
        <p className="mt-3 text-sm text-error-primary">{m.computer_attach_failed()}</p>
      )}
      <div className="mt-6 flex gap-3">
        <Button
          color="primary"
          className="flex-1"
          isDisabled={!workspaceId}
          onPress={() => void decide(true)}
        >
          {m.computer_attach_approve()}
        </Button>
        <Button color="secondary" className="flex-1" onPress={() => void decide(false)}>
          {m.computer_attach_refuse()}
        </Button>
      </div>
      <p className="mt-4 text-center text-xs text-secondary">
        <Button color="link-color" onPress={() => void navigate({ to: "/" })}>
          {m.controls_cancel()}
        </Button>
      </p>
    </main>
  );
}
