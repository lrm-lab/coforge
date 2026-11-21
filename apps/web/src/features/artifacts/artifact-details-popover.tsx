import { Fragment, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClockRewind,
  LinkBroken01,
  MessageTextSquare01,
} from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Focusable,
  Popover,
} from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import {
  FLOATING_SURFACE_CLASS,
  SECTION_LABEL_CLASS,
} from "#src/features/conversations/review-chrome";
import { useChannelPresence, usePresentUsers } from "#src/features/realtime/channel-presence";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { formatChangedPaths } from "./artifact-changed-paths";
import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { originJump, originLabel } from "./artifact-origin-link";
import { useArtifactTime } from "./artifact-parts";
import { artifactPresenceChannel } from "./artifact-presence-channel";
import { shapeRoster, useNameNewViewers } from "./artifact-presence-chip";
import { presenceSummary } from "./artifact-presence-summary";
import {
  artifactVersionsQuery,
  artifactViewersQuery,
  type ArtifactDocument,
} from "./artifact-queries";
import { visibilityIcon, type VisibilityChoice } from "./artifact-scope";
import type { ArtifactVisibility } from "./use-artifact-visibility";

const DETAIL_CHANGED_PATHS_SHOWN = 2;

type ArtifactOrigin = ArtifactDocument["artifact"]["origin"];

export function ArtifactDetailsPopover({
  artifactId,
  workspaceId,
  title,
  titleId,
  titleAs = "h1",
  isOpen,
  onOpenChange,
  triggerRef,
  shownVersion,
  latestVersion,
  visibility,
  home,
  homeName,
  origin,
  nameOf,
  presenceReady,
  onChooseVersion,
}: {
  artifactId: string;
  workspaceId: string | undefined;
  title: string;
  titleId: string;
  titleAs?: "h1" | "h2";
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerRef?: RefObject<HTMLElement | null>;
  shownVersion: number;
  latestVersion: number;
  visibility: ArtifactVisibility;
  home: ArtifactHome | undefined;
  homeName: string | undefined;
  origin: ArtifactOrigin | undefined;
  nameOf: (conversationId: string) => string | undefined;
  presenceReady: boolean;
  onChooseVersion: (version: number) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const Title = titleAs;
  const popover = (
    <Popover
      triggerRef={triggerRef}
      isOpen={triggerRef ? open : undefined}
      onOpenChange={triggerRef ? setOpen : undefined}
      placement="bottom start"
      className={cn(
        "flex max-h-[min(34rem,calc(100dvh-5rem))] w-80 max-w-[calc(100vw-1.5rem)] origin-(--trigger-anchor-point) flex-col",
        FLOATING_SURFACE_CLASS,
        POPOVER_MOTION,
      )}
    >
      <Dialog
        aria-label={m.av_details_label()}
        className="flex min-h-0 flex-col divide-y divide-border-secondary overflow-y-auto outline-hidden"
      >
        <VisibilitySection visibility={visibility} onClose={() => setOpen(false)} />
        <VersionSection
          artifactId={artifactId}
          shownVersion={shownVersion}
          latestVersion={latestVersion}
          onChooseVersion={(version) => {
            onChooseVersion(version);
            setOpen(false);
          }}
        />
        <LinksSection
          home={home}
          homeName={homeName}
          scope={visibility.current}
          origin={origin}
          nameOf={nameOf}
          onNavigate={() => setOpen(false)}
        />
        <PresenceSection workspaceId={workspaceId} artifactId={artifactId} ready={presenceReady} />
      </Dialog>
    </Popover>
  );

  if (triggerRef) return popover;

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Tooltip title={title} isDisabled={open} placement="bottom start">
        <AriaButton
          aria-label={m.av_details_trigger({ title })}
          className="relative flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-lg px-1.5 text-left outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-y-1.5 any-pointer-coarse:after:-inset-x-1"
        >
          <Title id={titleId} className="min-w-0 truncate text-sm font-medium text-primary">
            {title}
          </Title>
          <span className="sr-only">{m.av_details_label()}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        </AriaButton>
      </Tooltip>
      {popover}
    </DialogTrigger>
  );
}

function VisibilitySection({
  visibility,
  onClose,
}: {
  visibility: ArtifactVisibility;
  onClose: () => void;
}) {
  const { current, canChange, narrowable, linkAvailable, legacyLinkActive } = visibility;
  const choices = (["conversation", "workspace", "link"] as const).filter(
    (choice) =>
      choice === current ||
      (canChange &&
        (choice !== "link" || linkAvailable) &&
        (choice !== "conversation" || narrowable)),
  );
  const choose = (choice: VisibilityChoice) => {
    if (!canChange || choice === current) return;
    visibility.request(choice);
    onClose();
  };
  return (
    <section className="p-3">
      <h3 className={cn(SECTION_LABEL_CLASS, "mb-1.5 px-1")}>{m.av_who_can_see()}</h3>
      <div className="flex flex-col gap-0.5">
        {choices.map((choice) => {
          const Icon = visibilityIcon[choice];
          const selected = choice === current;
          if (!canChange) {
            return (
              <div
                key={choice}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-secondary"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                <span className="min-w-0 flex-1 truncate">{visibility.label[choice]}</span>
              </div>
            );
          }
          return (
            <AriaButton
              key={choice}
              onPress={() => choose(choice)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2",
                selected ? "font-medium text-primary" : "text-secondary",
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
              <span className="min-w-0 flex-1 truncate">{visibility.label[choice]}</span>
              {selected && (
                <Check aria-hidden="true" className="size-4 shrink-0 text-fg-brand-primary" />
              )}
            </AriaButton>
          );
        })}
        {canChange && legacyLinkActive && (
          <AriaButton
            onPress={() => {
              visibility.revokeLegacyLink();
              onClose();
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2"
          >
            <LinkBroken01 aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{m.av_vis_link_off_confirm()}</span>
          </AriaButton>
        )}
      </div>
    </section>
  );
}

function VersionSection({
  artifactId,
  shownVersion,
  latestVersion,
  onChooseVersion,
}: {
  artifactId: string;
  shownVersion: number;
  latestVersion: number;
  onChooseVersion: (version: number) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data } = useQuery({ ...artifactVersionsQuery(artifactId), enabled: historyOpen });
  const time = useArtifactTime();
  return (
    <section className="p-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5">
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-primary tabular-nums">
            v{shownVersion}
          </span>
          {shownVersion === latestVersion && (
            <span className="text-xs text-tertiary">{m.av_version_latest()}</span>
          )}
        </div>
        <AriaButton
          aria-expanded={historyOpen}
          onPress={() => setHistoryOpen((current) => !current)}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-tertiary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-secondary focus-visible:outline-2"
        >
          <ClockRewind aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{m.av_versions()}</span>
          {historyOpen ? (
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
          )}
        </AriaButton>
      </div>
      {historyOpen && (
        <ul className="mt-2 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {(data ?? []).map((version) => {
            const changed = formatChangedPaths(
              version.changedPaths,
              version.changedCount,
              DETAIL_CHANGED_PATHS_SHOWN,
            );
            const active = version.number === shownVersion;
            const byLine = m.av_version_by({
              name: version.publisher.name,
              time: time(version.createdAt),
            });
            const tooltipTitle = version.note || byLine;
            const tooltipDescription = [version.note ? byLine : null, changed]
              .filter(Boolean)
              .join("\n");
            return (
              <li key={version.number}>
                <Tooltip
                  title={tooltipTitle}
                  description={tooltipDescription || undefined}
                  placement="left"
                >
                  <AriaButton
                    onPress={() => onChooseVersion(version.number)}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-focus-ring transition-colors duration-150 hover:bg-primary_hover focus-visible:outline-2",
                      active && "bg-active",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-primary tabular-nums">
                          v{version.number}
                        </span>
                        {version.latest && (
                          <span className="text-xs text-tertiary">{m.av_version_latest()}</span>
                        )}
                      </span>
                      <span className="truncate text-xs text-tertiary">{byLine}</span>
                      {version.note && (
                        <span className="truncate text-xs text-tertiary">{version.note}</span>
                      )}
                      {changed && (
                        <span className="truncate text-xs text-quaternary">{changed}</span>
                      )}
                    </span>
                    {active && (
                      <Check
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-fg-brand-primary"
                      />
                    )}
                  </AriaButton>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LinksSection({
  home,
  homeName,
  scope,
  origin,
  nameOf,
  onNavigate,
}: {
  home: ArtifactHome | undefined;
  homeName: string | undefined;
  scope: VisibilityChoice;
  origin: ArtifactOrigin | undefined;
  nameOf: (conversationId: string) => string | undefined;
  onNavigate: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const showHome = Boolean(
    home && scope !== "conversation" && homeConversationOf(home) && homeName,
  );
  const showOrigin = Boolean(origin);
  if (!showHome && !showOrigin) return null;
  const resolvedOriginLabel =
    origin && !("hidden" in origin) ? originLabel(origin, nameOf(origin.conversationId)) : "";
  return (
    <section className="flex flex-col gap-1.5 p-3">
      {showHome && home && homeName && (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className={SECTION_LABEL_CLASS}>{m.av_details_home()}</span>
          <Tooltip title={homeName} placement="top end">
            <Focusable>
              <Link
                {...homeLinkProps(home, workspaceSlug)}
                onClick={onNavigate}
                className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-xs font-medium text-secondary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-primary focus-visible:outline-2"
              >
                {homeName}
              </Link>
            </Focusable>
          </Tooltip>
        </div>
      )}
      {showOrigin && origin && (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className={SECTION_LABEL_CLASS}>{m.av_details_origin()}</span>
          {"hidden" in origin ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-tertiary">
              <MessageTextSquare01 aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{m.av_origin_hidden()}</span>
            </span>
          ) : (
            <Tooltip title={resolvedOriginLabel} placement="top end">
              <Focusable>
                <Link
                  {...conversationRoute(
                    origin.homeKind === "channel"
                      ? { channelId: origin.conversationId }
                      : { dmId: origin.conversationId },
                    workspaceSlug,
                  )}
                  {...originJump(origin)}
                  onClick={onNavigate}
                  className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-secondary outline-focus-ring transition-colors duration-150 hover:bg-primary_hover hover:text-primary focus-visible:outline-2"
                >
                  <MessageTextSquare01 aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{resolvedOriginLabel}</span>
                </Link>
              </Focusable>
            </Tooltip>
          )}
        </div>
      )}
    </section>
  );
}

function PresenceSection({
  workspaceId,
  artifactId,
  ready,
}: {
  workspaceId: string | undefined;
  artifactId: string;
  ready: boolean;
}) {
  const present = usePresentUsers(
    useChannelPresence(
      ready && workspaceId ? artifactPresenceChannel(workspaceId, artifactId) : undefined,
    ),
  );
  const { data: roster } = useQuery({ ...artifactViewersQuery(artifactId), enabled: ready });
  useNameNewViewers(artifactId, roster, present);
  const data = roster && shapeRoster(roster, present ?? new Set([roster.you]));
  if (!data) return null;
  const othersCount = present ? present.size - (present.has(data.you) ? 1 : 0) : 0;
  const summary = presenceSummary({
    othersViewing: othersCount,
    youViewing: present?.has(data.you) ?? true,
    seenLatest: data.seenLatest,
  }).map((part) =>
    part.kind === "viewing"
      ? m.av_presence_summary_viewing({ count: part.count })
      : part.kind === "you"
        ? m.av_presence_summary_you()
        : m.av_presence_summary_saw_latest({ count: part.count }),
  );
  const nameOf = (person: { userId: string; name: string }) =>
    person.userId === data.you ? m.av_presence_you() : person.name;
  return (
    <section className="p-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
        <h3 className={SECTION_LABEL_CLASS}>{m.av_presence_label()}</h3>
        {summary.length > 0 && (
          <p className="truncate text-xs text-quaternary">
            {summary.map((part, index) => (
              <Fragment key={part}>
                {index > 0 && ", "}
                <span className="whitespace-nowrap">{part}</span>
              </Fragment>
            ))}
          </p>
        )}
      </div>
      <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
        {data.viewingNow.map((person) => (
          <PresenceRow
            key={person.userId}
            person={person}
            name={nameOf(person)}
            detail={m.av_presence_now()}
          />
        ))}
        {data.others.map((person) => (
          <PresenceRow
            key={person.userId}
            person={person}
            name={nameOf(person)}
            detail={
              <>
                <RelativeTime value={person.openedAt} plain />
                {person.seenVersion < data.currentVersion &&
                  `, ${m.av_presence_saw({ version: person.seenVersion })}`}
              </>
            }
          />
        ))}
      </ul>
    </section>
  );
}

function PresenceRow({
  person,
  name,
  detail,
}: {
  person: { userId: string; name: string; avatarUrl: string | null };
  name: string;
  detail: ReactNode;
}) {
  return (
    <li className="flex h-8 items-center gap-2 rounded-md px-2 text-sm">
      <ActorAvatar
        presence={false}
        userId={person.userId}
        src={person.avatarUrl ?? undefined}
        name={person.name}
        size="xs"
      />
      <Tooltip title={name} placement="top start">
        <Focusable>
          <span
            tabIndex={0}
            className="min-w-0 flex-1 cursor-default truncate rounded-sm text-left font-medium text-secondary outline-focus-ring focus-visible:outline-2"
          >
            {name}
          </span>
        </Focusable>
      </Tooltip>
      <span className="shrink-0 text-xs text-tertiary">{detail}</span>
    </li>
  );
}
