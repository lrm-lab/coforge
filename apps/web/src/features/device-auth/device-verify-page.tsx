import { useState } from "react";
import { Radio, RadioGroup } from "react-aria-components";
import {
  Check,
  Laptop01 as Laptop,
  ShieldZap as ShieldAlert,
  XClose as X,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "#src/components/ui/input-otp";
import type {
  ApprovableExternalAgent,
  ExternalGrantDetails,
} from "#src/server/auth/device-auth-external-agent.server";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { formatUserCode, USER_CODE_LENGTH } from "./device-code-format";
import {
  approveDeviceCode,
  checkDeviceCode,
  denyDeviceCode,
  listApprovableExternalAgents,
  type DeviceCodeState,
} from "./device-auth.functions";

type Stage =
  | { name: "entry" }
  | {
      name: "confirm";
      code: string;
      grant?: ExternalGrantDetails;
      agents: ApprovableExternalAgent[];
    }
  | { name: "approved" }
  | { name: "denied" };

const CODE_PATTERN = "[BCDFGHJKMNPQRSTVWXYZbcdfghjkmnpqrstvwxyz23456789]*";

function problemMessage(state: DeviceCodeState): string | null {
  if (state === "unknown") return m.device_verify_unknown();
  if (state === "expired") return m.device_verify_expired();
  if (state === "settled") return m.device_verify_settled();
  if (state === "unavailable") return m.device_verify_unavailable();
  if (state === "not_authorized") return m.device_verify_not_authorized();
  if (state === "agent_not_external") return m.device_verify_agent_not_external();
  if (state === "agent_unavailable") return m.device_verify_agent_unavailable();
  if (state === "credential_limit") return m.device_verify_credential_limit();
  if (state === "agent_not_found") return m.device_verify_agent_not_found();
  if (state === "mint_rate_limited") return m.device_verify_mint_rate_limited();
  return null;
}

export function DeviceVerifyPage({ account }: { account: string }) {
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ name: "entry" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const complete = code.length === USER_CODE_LENGTH;

  async function submitCode(value: string = code) {
    if (busy || value.length !== USER_CODE_LENGTH) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await checkDeviceCode({ data: { userCode: value } });
      if (result.state !== "ok") {
        setProblem(problemMessage(result.state));
        return;
      }
      const agents = result.grant ? (await listApprovableExternalAgents()).agents : [];
      setAgentId(agents.length === 1 ? agents[0]!.agentId : null);
      setStage({ name: "confirm", code: value, grant: result.grant, agents });
    } finally {
      setBusy(false);
    }
  }

  async function settle(approve: boolean) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = approve
        ? await approveDeviceCode({ data: { userCode: code, agentId: agentId ?? undefined } })
        : await denyDeviceCode({ data: { userCode: code } });
      if (result.state === "ok") setStage(approve ? { name: "approved" } : { name: "denied" });
      else {
        setProblem(problemMessage(result.state));
        setStage({ name: "entry" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-primary px-[max(1rem,var(--spacing-safe-left))] pt-[max(4rem,var(--spacing-safe-top))] pb-[max(4rem,var(--spacing-safe-bottom))] sm:px-6">
      <div className="w-full max-w-md">
        {stage.name === "approved" || stage.name === "denied" ? (
          <Settled approved={stage.name === "approved"} />
        ) : (
          <>
            <div
              className={`mx-auto mb-6 flex size-14 items-center justify-center rounded-xl ${
                stage.name === "confirm"
                  ? "bg-primary text-brand-secondary ring-1 ring-brand"
                  : "bg-primary text-primary ring-1 ring-secondary"
              }`}
            >
              {stage.name === "confirm" ? (
                <ShieldAlert className="size-7" aria-hidden="true" />
              ) : (
                <Laptop className="size-7" aria-hidden="true" />
              )}
            </div>

            <h1 className="text-center text-display-xs font-semibold text-primary">
              {stage.name !== "confirm"
                ? m.device_verify_title()
                : stage.grant
                  ? m.device_verify_external_title()
                  : m.device_verify_confirm_title()}
            </h1>
            <p className="mt-2 text-center text-sm text-tertiary">
              {stage.name !== "confirm"
                ? m.device_verify_description()
                : stage.grant
                  ? m.device_verify_external_description({ code: formatUserCode(stage.code) })
                  : m.device_verify_confirm_description({ code: formatUserCode(stage.code) })}
            </p>

            {stage.name === "entry" ? (
              <div className="mt-8">
                <div className="flex justify-center">
                  <InputOTP
                    containerClassName="gap-2"
                    maxLength={USER_CODE_LENGTH}
                    value={code}
                    pattern={CODE_PATTERN}
                    pasteTransformer={(pasted: string) =>
                      pasted.replace(/[\s-]/g, "").toUpperCase()
                    }
                    onChange={(next: string) => {
                      setCode(next.toUpperCase());
                      setProblem(null);
                    }}
                    onComplete={submitCode}
                    disabled={busy}
                    aria-label={m.device_verify_code_label()}
                    aria-invalid={problem !== null || undefined}
                    autoFocus
                  >
                    <InputOTPGroup className="gap-1 sm:gap-2">
                      {[0, 1, 2, 3].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="h-12 w-7 text-lg sm:h-14 sm:w-10 sm:text-xl"
                        />
                      ))}
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup className="gap-1 sm:gap-2">
                      {[4, 5, 6, 7].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="h-12 w-7 text-lg sm:h-14 sm:w-10 sm:text-xl"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {problem ? (
                  <HintText isInvalid role="alert" className="mt-4 text-center">
                    {problem}
                  </HintText>
                ) : null}
                <Button
                  type="button"
                  size="lg"
                  className="mt-6 w-full"
                  isDisabled={busy || !complete}
                  onPress={() => submitCode()}
                >
                  {busy ? m.device_verify_checking() : m.device_verify_continue()}
                </Button>
              </div>
            ) : (
              <div className="mt-6 space-y-6">
                {stage.grant ? (
                  <>
                    <ExternalAgentChoice
                      agents={stage.agents}
                      value={agentId}
                      onChange={setAgentId}
                      isDisabled={busy}
                    />
                    <ExternalGrantSummary grant={stage.grant} />
                  </>
                ) : null}
                <div className="flex gap-3">
                  <Button
                    type="button"
                    color="secondary"
                    size="lg"
                    className="flex-1"
                    isDisabled={busy}
                    onPress={() => settle(false)}
                  >
                    {m.device_verify_deny()}
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    className="flex-1"
                    isDisabled={busy || (stage.grant !== undefined && agentId === null)}
                    onPress={() => settle(true)}
                  >
                    {m.device_verify_approve()}
                  </Button>
                </div>
              </div>
            )}

            <p className="mt-8 text-center text-sm break-words text-tertiary">
              {m.device_verify_signed_in_as({ account })}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function ExternalAgentChoice({
  agents,
  value,
  onChange,
  isDisabled,
}: {
  agents: ApprovableExternalAgent[];
  value: string | null;
  onChange: (agentId: string) => void;
  isDisabled: boolean;
}) {
  if (agents.length === 0)
    return (
      <p role="alert" className="text-center text-sm text-error-primary">
        {m.device_verify_external_none()}
      </p>
    );
  return (
    <RadioGroup
      aria-label={m.device_verify_external_choose()}
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
      className="space-y-2"
    >
      <p className="text-sm font-medium text-secondary">{m.device_verify_external_choose()}</p>
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {agents.map((agent) => (
          <Radio
            key={agent.agentId}
            value={agent.agentId}
            className={({ isSelected, isFocusVisible }) =>
              cx(
                "flex cursor-pointer flex-col rounded-lg border px-3 py-2 transition duration-100 ease-linear",
                isSelected
                  ? "border-brand bg-secondary"
                  : "border-secondary hover:bg-primary_hover",
                isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
              )
            }
          >
            <span className="truncate text-sm font-medium text-primary">
              {agent.displayName || agent.name}
            </span>
            <span className="truncate text-xs text-tertiary">
              @{agent.name} · {agent.workspaceName || agent.workspaceSlug}
            </span>
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

function ExternalGrantSummary({ grant }: { grant: ExternalGrantDetails }) {
  const machineLabel = grant.machine.machineName || grant.machine.hostname || "—";
  const rows = [
    { label: m.device_verify_external_machine_label(), value: machineLabel },
    ...(grant.machine.os
      ? [{ label: m.device_verify_external_os_label(), value: grant.machine.os }]
      : []),
    ...(grant.machine.clientName
      ? [{ label: m.device_verify_external_client_label(), value: grant.machine.clientName }]
      : []),
  ];
  return (
    <div className="rounded-xl border border-secondary bg-secondary_subtle p-4 text-sm">
      <p className="text-xs text-tertiary">{m.device_verify_external_machine()}</p>
      <dl className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-xs text-tertiary">{row.label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Settled({ approved }: { approved: boolean }) {
  return (
    <div className="py-2 text-center">
      <div
        className={`mx-auto flex size-14 items-center justify-center rounded-full ring-8 ${
          approved
            ? "bg-success-primary text-success-primary ring-utility-green-100"
            : "bg-secondary text-tertiary ring-secondary"
        }`}
      >
        {approved ? (
          <Check className="size-7" aria-hidden="true" />
        ) : (
          <X className="size-7" aria-hidden="true" />
        )}
      </div>
      <h1 className="mt-6 text-display-xs font-semibold text-primary">
        {approved ? m.device_verify_approved_title() : m.device_verify_denied_title()}
      </h1>
      <p className="mt-2 text-sm text-tertiary">
        {approved ? m.device_verify_approved_description() : m.device_verify_denied_description()}
      </p>
    </div>
  );
}
