import { AlertCircle, ArrowLeft, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { m } from "#src/paraglide/messages";

export function AgentProfileUnavailable({
  notVisible,
  loadFailed = false,
  retrying = false,
  onRetry,
  back,
  onClose,
}: {
  notVisible: boolean;
  loadFailed?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  back?: { label: string; onPress: () => void };
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-secondary px-2">
        {back ? (
          <ButtonUtility
            icon={ArrowLeft}
            size="sm"
            color="tertiary"
            className="[&_svg]:rtl:rotate-180"
            tooltip={back.label}
            aria-label={back.label}
            onClick={back.onPress}
          />
        ) : (
          <span />
        )}
        <ButtonUtility
          icon={X}
          size="sm"
          color="tertiary"
          tooltip={m.controls_close()}
          onClick={onClose}
        />
      </header>
      {loadFailed ? (
        <EmptyState
          size="page"
          role="alert"
          headingLevel={2}
          picture={<EmptyIcon icon={AlertCircle} />}
          title={m.empty_agent_profile_load_failed_title()}
          description={m.empty_load_failed_safe()}
          primaryAction={
            onRetry ? (
              <RetryButton size="page" isRetrying={retrying} onPress={onRetry} />
            ) : undefined
          }
        />
      ) : (
        <EmptyState
          size="page"
          headingLevel={2}
          picture={<LockedWireframe />}
          title={
            notVisible ? m.empty_agent_profile_private_title() : m.agent_profile_not_found_title()
          }
          description={
            notVisible
              ? m.empty_agent_profile_private_description()
              : m.agent_profile_not_found_description()
          }
          primaryAction={
            <Button size="sm" color="tertiary" onPress={onClose}>
              {m.controls_close()}
            </Button>
          }
        />
      )}
    </div>
  );
}
