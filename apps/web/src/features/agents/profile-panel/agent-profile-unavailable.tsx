import { ArrowLeft, UserX01, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";

/** The panel when its Agent's profile could not be read: a bare header and one fact. `notVisible`
 * is an Agent that exists but is private to someone else. */
export function AgentProfileUnavailable({
  notVisible,
  back,
  onClose,
}: {
  notVisible: boolean;
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
      <Empty className="flex-1 items-center justify-center px-6 text-center">
        <EmptyHeader className="items-center gap-3">
          <EmptyMedia>
            <UserX01 aria-hidden="true" className="size-6 text-tertiary" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={2}>
            {notVisible ? m.agent_not_visible() : m.agent_profile_not_found_title()}
          </EmptyTitle>
          {!notVisible && (
            <EmptyDescription>{m.agent_profile_not_found_description()}</EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    </div>
  );
}
