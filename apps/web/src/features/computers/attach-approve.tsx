import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import {
  approveComputerAttach,
  refuseComputerAttach,
} from "#src/features/computers/attach-approve.functions";

/**
 * The approval page a `coforge-computer attach` link opens (task #417): the machine's reported
 * name, host and OS, the userCode the person compares with the CLI's, the workspaces they may
 * attach it to, and Approve / Refuse. Refusing settles the session for good; the machine's next
 * poll hears `access_denied`.
 */
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
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">Computer attached</h1>
        <p className="mt-2 text-sm text-secondary">
          {machineName} is attaching to the workspace you chose. You can close this page.
        </p>
      </main>
    );
  if (state === "refused")
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">Attach refused</h1>
        <p className="mt-2 text-sm text-secondary">
          The computer will not attach. You can close this page.
        </p>
      </main>
    );

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-xl font-semibold">Attach a computer</h1>
      <p className="mt-2 text-sm text-secondary">
        A computer asked to attach. Check the code below matches what its terminal shows before you
        approve. Only approve a computer you are operating yourself — if someone sent you this link,
        do not approve it.
      </p>
      <dl className="mt-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-secondary">Machine</dt>
          <dd className="font-medium">{machineName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-secondary">Hostname</dt>
          <dd className="font-medium">{hostname}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-secondary">OS</dt>
          <dd className="font-medium">{os}</dd>
        </div>
      </dl>
      <p className="mt-6 text-center text-2xl font-mono font-semibold tracking-widest">
        {userCode}
      </p>
      <p className="mt-1 text-center text-xs text-secondary">
        Confirm this matches the code on the computer's screen.
      </p>
      <div className="mt-6">
        <Select
          aria-label="Attach to"
          selectedKey={workspaceId}
          onSelectionChange={(key) => setWorkspaceId(String(key))}
          items={workspaces.map((workspace) => ({ id: workspace.id, label: workspace.slug }))}
        >
          {(workspace) => <Select.Item id={workspace.id} label={workspace.label} />}
        </Select>
      </div>
      {state === "failed" && (
        <p className="mt-3 text-sm text-error-primary">
          That did not work — the session may have expired or been decided already.
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <Button
          color="primary"
          className="flex-1"
          isDisabled={!workspaceId}
          onClick={() => void decide(true)}
        >
          Approve
        </Button>
        <Button color="secondary" className="flex-1" onClick={() => void decide(false)}>
          Refuse
        </Button>
      </div>
      <p className="mt-4 text-center text-xs text-secondary">
        <Button color="link-color" onClick={() => void navigate({ to: "/" })}>
          Cancel
        </Button>
      </p>
    </main>
  );
}
