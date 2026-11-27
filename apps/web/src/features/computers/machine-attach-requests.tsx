import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { formatMonthDayTime } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { denyMachineAttachFromList, type listMachineAttach } from "./machine-attach.functions";
import { MachineAttachReason, MachineAttachStatus } from "./machine-attach-status";

type AttachRequest = NonNullable<Awaited<ReturnType<typeof listMachineAttach>>>[number];

export function MachineAttachRequests({
  requests,
  activeId,
  updatedAt,
  timeZone,
  onChange,
}: {
  requests: AttachRequest[];
  activeId?: string;
  updatedAt: number;
  timeZone?: string | null;
  onChange?: () => Promise<unknown>;
}) {
  if (!requests.length) return null;
  return (
    <section aria-label={m.computer_attach_request_title()} className="mb-5 min-w-0">
      <h2 className="mb-2 text-md font-semibold text-primary">
        {m.computer_attach_request_title()}
      </h2>
      <ul className="divide-y divide-secondary border-y border-secondary">
        {requests.map((request) => (
          <MachineAttachRequestRow
            key={request.id}
            request={request}
            selected={request.id === activeId}
            timeZone={timeZone}
            updatedAt={updatedAt}
            onChange={onChange}
          />
        ))}
      </ul>
    </section>
  );
}

function MachineAttachRequestRow({
  request,
  selected,
  timeZone,
  updatedAt,
  onChange,
}: {
  request: AttachRequest;
  selected: boolean;
  updatedAt: number;
  timeZone?: string | null;
  onChange?: () => Promise<unknown>;
}) {
  const deny = useServerFn(denyMachineAttachFromList);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remainingMinutes = Math.max(
    0,
    Math.ceil((Date.parse(request.expiresAt) - updatedAt) / 60_000),
  );
  const time = (stamp: string) => formatMonthDayTime(stamp, timeZone, getLocale());
  const pending = request.status === "awaiting_approval";
  const denyFromList = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if (!(await deny({ data: { sessionId: request.id } })).accepted) setFailed(true);
      await onChange?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cn("min-w-0 px-2 py-2.5", selected && "bg-active")}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to="/computers/attach/$sessionId"
            params={{ sessionId: request.id }}
            aria-current={selected ? "page" : undefined}
            className="block w-fit max-w-full rounded-sm text-sm font-semibold wrap-anywhere text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            {request.machineName}
          </Link>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-sm text-tertiary">
            <span>{m.computer_attach_requested_at({ time: time(request.createdAt) })}</span>
            {pending || request.status === "approved" || request.status === "completing" ? (
              <span>{m.computer_attach_minutes_left({ minutes: remainingMinutes })}</span>
            ) : request.finishedAt ? (
              <span>{m.computer_attach_finished_at({ time: time(request.finishedAt) })}</span>
            ) : null}
          </div>
        </div>
        <MachineAttachStatus status={request.status} />
        {pending && onChange ? (
          <Button
            type="button"
            size="sm"
            color="tertiary"
            className="min-h-11"
            isDisabled={busy}
            onPress={() => void denyFromList()}
          >
            {m.computer_attach_refuse()}
          </Button>
        ) : null}
      </div>
      {request.failureReason ? (
        <p className="mt-1 text-sm text-tertiary">
          <MachineAttachReason reason={request.failureReason} />
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-1 text-sm text-error-primary">
          {m.computer_attach_failed()}
        </p>
      ) : null}
    </li>
  );
}
