import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";

export function MachineAttachStatus({ status }: { status: string }) {
  switch (status) {
    case "awaiting_approval":
      return (
        <Badge size="sm" color="warning">
          {m.computer_attach_state_pending()}
        </Badge>
      );
    case "denied":
      return (
        <Badge size="sm" color="error">
          {m.computer_attach_state_denied()}
        </Badge>
      );
    case "expired":
      return (
        <Badge size="sm" color="gray">
          {m.computer_attach_state_expired()}
        </Badge>
      );
    case "failed":
      return (
        <Badge size="sm" color="gray">
          {m.computer_attach_state_timeout()}
        </Badge>
      );
    case "ready":
      return (
        <Badge size="sm" color="success">
          {m.computer_attach_state_connected()}
        </Badge>
      );
    default:
      return (
        <Badge size="sm" color="gray">
          {m.computer_attach_state_connecting()}
        </Badge>
      );
  }
}

export function MachineAttachReason({ reason }: { reason: string | null }) {
  if (reason === "denied") return <>{m.computer_attach_reason_denied()}</>;
  if (reason !== "approval_expired" && reason !== "completion_timeout") return null;
  return (
    <>
      {reason === "approval_expired"
        ? m.computer_attach_reason_expired()
        : m.computer_attach_reason_timeout()}{" "}
      {m.computer_attach_retry_on_computer()}{" "}
      <code className="rounded-sm bg-secondary px-1 py-0.5 font-mono">coforge-computer attach</code>
    </>
  );
}
