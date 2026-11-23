import { useEffect, useState, type ReactNode } from "react";
import { Check, RefreshCw01 as RotateCw } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ComputerUpgradeProgress, ComputerUpgradeStatus } from "./computer.schemas";
import {
  buildComputerUpgradeProgressView,
  type UpgradeProgressStep,
  type UpgradeStepTone,
} from "./computer-upgrade-progress-view";
import type { UpgradeRequestErrorCopy } from "./upgrade-failure";

export function ComputerUpgradeProgressSlot({
  progress,
  status,
  failure,
  canUpgrade,
  canRetryOffer,
  online,
  upgradeInFlight,
  whatsNew,
  onUpgrade,
}: {
  progress: ComputerUpgradeProgress;
  status?: ComputerUpgradeStatus;
  failure?: UpgradeRequestErrorCopy;
  canUpgrade: boolean;
  canRetryOffer: boolean;
  online: boolean;
  upgradeInFlight: boolean;
  whatsNew?: ReactNode;
  onUpgrade: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const hasActiveClock =
    (progress.switchState === "target_online" && now < progress.expiresAt) ||
    (progress.switchState === "confirmed" &&
      progress.workspaces.some((row) => row.state === "waiting") &&
      progress.reconnectUntil !== undefined &&
      now < progress.reconnectUntil);

  useEffect(() => {
    setNow(Date.now());
    if (!hasActiveClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasActiveClock, progress.expiresAt, progress.reconnectUntil, progress.switchState]);

  const view = buildComputerUpgradeProgressView({
    progress,
    status,
    failureHeadline: failure?.headline,
    now,
  });
  const showRetry = canUpgrade && view.canRetry && canRetryOffer;

  return (
    <Alert
      color={view.alertColor}
      className="mt-3"
      title={view.title}
      actions={
        (whatsNew || showRetry) && (
          <>
            {whatsNew}
            {showRetry && (
              <Button
                type="button"
                size="sm"
                color="secondary"
                iconLeading={RotateCw}
                isDisabled={!online || upgradeInFlight}
                onPress={onUpgrade}
              >
                {m.computer_upgrade_retry()}
              </Button>
            )}
          </>
        )
      }
      description={
        <div>
          <p className="font-medium text-primary">{view.headline}</p>
          <p className="mt-0.5 text-tertiary">{view.detail}</p>
          <ol className="mt-3 flex flex-col gap-2 text-sm">
            {view.steps.map((step) => (
              <ProgressStepRow key={step.id} step={step} />
            ))}
          </ol>
          {view.workspaces.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2 border-t border-secondary pt-2.5 text-sm">
              {view.workspaces.map((row) => (
                <li
                  key={row.workspaceId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                >
                  <span className="min-w-0 wrap-anywhere text-primary">{row.name}</span>
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      row.tone === "good"
                        ? "text-fg-success-primary"
                        : row.tone === "warn"
                          ? "text-warning-primary"
                          : "text-tertiary",
                    )}
                  >
                    {row.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}

function ProgressStepRow({ step }: { step: UpgradeProgressStep }) {
  return (
    <li
      className="flex items-start gap-2.5"
      aria-current={step.status === "current" ? "step" : undefined}
    >
      <StepMarker status={step.status} />
      <span
        className={cn(
          "min-w-0 font-medium",
          step.status === "incomplete" ? "text-quaternary" : "text-primary",
        )}
      >
        {step.label}
      </span>
    </li>
  );
}

function StepMarker({ status }: { status: UpgradeStepTone }) {
  if (status === "complete") {
    return <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-success-primary" />;
  }
  if (status === "current") {
    return (
      <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <span className="size-2 rounded-full bg-fg-brand-primary" />
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-xs leading-none font-semibold text-warning-primary"
      >
        ?
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-xs leading-none font-semibold text-error-primary"
      >
        !
      </span>
    );
  }
  return (
    <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full border border-primary" />
    </span>
  );
}
