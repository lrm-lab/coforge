import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useHydrated, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ArrowUpRight, Inbox01, Paperclip } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Select, type SelectItemType } from "#src/components/base/select/select";
import { Dot } from "#src/components/foundations/dot-icon";
import { PageHeader } from "#src/components/layout/page-header";
import { Alert } from "#src/components/ui/alert";
import { EmptyState } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { formatDateForDisplay } from "#src/lib/dates";
import { humanLabel } from "#src/lib/human-label";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { cx } from "#src/utils/cx";
import { saveFeedbackRouting, updateFeedbackStatus } from "./feedback.functions";
import {
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackItemSummary,
  type FeedbackRoutingOption,
  type FeedbackRoutingSummary,
  type FeedbackStatus,
} from "./feedback-types";

const ROUTING_OFF_KEY = "__off__";

const CATEGORY_LABELS: Record<FeedbackCategory, () => string> = {
  bug: m.feedback_category_bug,
  idea: m.feedback_category_idea,
  other: m.feedback_category_other,
};

const CATEGORY_BADGE_COLORS: Record<FeedbackCategory, "error" | "brand" | "gray"> = {
  bug: "error",
  idea: "brand",
  other: "gray",
};

const STATUS_LABELS: Record<FeedbackStatus, () => string> = {
  open: m.feedback_status_open,
  triaged: m.feedback_status_triaged,
  resolved: m.feedback_status_resolved,
  archived: m.feedback_status_archived,
};

const STATUS_DOT_COLORS: Record<FeedbackStatus, string> = {
  open: "text-utility-blue-500",
  triaged: "text-utility-brand-500",
  resolved: "text-utility-green-500",
  archived: "text-fg-quaternary",
};

export function FeedbackInboxPage({
  items,
  statusFilter,
  routing,
  routingOptions,
}: {
  items: FeedbackItemSummary[];
  statusFilter?: FeedbackStatus;
  routing: FeedbackRoutingSummary;
  routingOptions: FeedbackRoutingOption[];
}) {
  const slug = useWorkspaceSlug();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useAppToast();
  const saveRouting = useServerFn(saveFeedbackRouting);
  const [savingRouting, guardRouting] = useSubmitGuard();
  const [routingError, setRoutingError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => items[0]?.id ?? null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const selectedFilterKey = statusFilter ?? "all";
  const activeItem =
    (selectedId ? items.find((item) => item.id === selectedId) : undefined) ?? items[0] ?? null;

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      setMobileDetailOpen(false);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items[0]!.id);
      setMobileDetailOpen(false);
    }
  }, [items, selectedId]);

  const routingSelectItems = useMemo<SelectItemType[]>(() => {
    const channelItems: SelectItemType[] = routingOptions.map((option) => ({
      id: option.channelId,
      label: `#${option.channelName} (${option.workspaceName})`,
    }));
    if (routing && !routingOptions.some((option) => option.channelId === routing.channelId)) {
      channelItems.unshift({
        id: routing.channelId,
        label: `#${routing.channelName} (${routing.workspaceName})`,
      });
    }
    return [{ id: ROUTING_OFF_KEY, label: m.feedback_routing_off() }, ...channelItems];
  }, [routing, routingOptions]);

  const selectedRoutingKey = routing?.channelId ?? ROUTING_OFF_KEY;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-primary">
      <PageHeader
        heading={m.feedback_inbox_title()}
        breadcrumbs={[
          {
            label: m.settings_title(),
            link: (className) => (
              <Link
                to="/w/$workspaceSlug/settings"
                params={{ workspaceSlug: slug }}
                activeOptions={{ exact: true }}
                className={className}
              >
                {m.settings_title()}
              </Link>
            ),
          },
          {
            label: m.apps_review_title(),
            link: (className) => (
              <Link
                to="/w/$workspaceSlug/app-review"
                params={{ workspaceSlug: slug }}
                activeOptions={{ exact: true }}
                className={className}
              >
                {m.apps_review_title()}
              </Link>
            ),
          },
        ]}
      />

      <section
        aria-label={m.feedback_inbox_title()}
        className="flex min-h-0 w-full flex-1 flex-col gap-3 px-page py-4"
      >
        <div
          className={cx(
            "shrink-0 flex-col gap-2.5 lg:flex lg:flex-row lg:items-center lg:justify-between",
            mobileDetailOpen ? "hidden" : "flex",
          )}
        >
          <Tabs
            selectedKey={selectedFilterKey}
            onSelectionChange={(key) => {
              const next = String(key);
              void navigate({
                to: "/w/$workspaceSlug/feedback",
                params: { workspaceSlug: slug },
                search: next === "all" ? {} : { status: next as FeedbackStatus },
              });
            }}
            className="w-fit max-w-full"
          >
            <Tabs.List type="button-minimal" size="sm" className="w-fit max-w-full flex-wrap">
              <Tabs.Item id="all">{m.feedback_inbox_filter_all()}</Tabs.Item>
              {FEEDBACK_STATUSES.map((status) => (
                <Tabs.Item key={status} id={status}>
                  {STATUS_LABELS[status]()}
                </Tabs.Item>
              ))}
            </Tabs.List>
          </Tabs>

          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-tertiary">
              {m.feedback_routing_label()}
            </span>
            <div className="min-w-0 flex-1 sm:w-[16rem] sm:flex-initial">
              <Select
                aria-label={m.feedback_routing_label()}
                size="sm"
                items={routingSelectItems}
                selectedKey={selectedRoutingKey}
                isDisabled={savingRouting}
                popoverClassName="min-w-[16rem]"
                onSelectionChange={(key) => {
                  if (!key) return;
                  const nextKey = String(key);
                  const nextChannelId = nextKey === ROUTING_OFF_KEY ? null : nextKey;
                  if (nextChannelId === (routing?.channelId ?? null)) return;
                  void guardRouting(async () => {
                    setRoutingError("");
                    try {
                      await saveRouting({ data: { channelId: nextChannelId } });
                      await router.invalidate({ sync: true });
                      const chosen = nextChannelId
                        ? routingOptions.find((option) => option.channelId === nextChannelId)
                        : null;
                      toast.success(
                        chosen
                          ? m.feedback_routing_saved_channel({ channel: `#${chosen.channelName}` })
                          : m.feedback_routing_saved_off(),
                      );
                    } catch {
                      setRoutingError(m.feedback_routing_save_error());
                    }
                  });
                }}
              >
                {(option) => <Select.Item id={option.id}>{option.label}</Select.Item>}
              </Select>
            </div>
          </div>
        </div>

        {routingError && <Alert color="error" title={routingError} />}

        {items.length === 0 ? (
          <EmptyState
            size="page"
            headingLevel={2}
            className="max-w-none rounded-xl border border-dashed border-secondary px-4 py-12"
            picture={<EmptyIcon icon={Inbox01} muted />}
            title={m.feedback_inbox_empty_title()}
            description={m.feedback_inbox_empty_description()}
          />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-secondary bg-primary">
            <div
              className={cx(
                "min-h-0 w-full flex-col overflow-y-auto border-secondary lg:flex lg:w-[23rem] lg:shrink-0 lg:border-r xl:w-[26rem]",
                mobileDetailOpen ? "hidden" : "flex",
              )}
            >
              <ul className="divide-y divide-secondary">
                {items.map((item) => (
                  <FeedbackListRow
                    key={item.id}
                    item={item}
                    selected={activeItem?.id === item.id}
                    onSelect={() => {
                      setSelectedId(item.id);
                      setMobileDetailOpen(true);
                    }}
                  />
                ))}
              </ul>
            </div>

            {activeItem && (
              <div
                className={cx(
                  "min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex",
                  mobileDetailOpen ? "flex" : "hidden",
                )}
              >
                <FeedbackDetailInspector
                  key={activeItem.id}
                  item={activeItem}
                  onBack={() => setMobileDetailOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function FeedbackListRow({
  item,
  selected,
  onSelect,
}: {
  item: FeedbackItemSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const timeZone = useTimeZone();
  const authorName = item.author
    ? humanLabel({ displayName: item.author.name })
    : m.feedback_inbox_unknown_user();

  return (
    <li>
      <AriaButton
        aria-current={selected ? "true" : undefined}
        onPress={onSelect}
        className={cx(
          "relative flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left transition-colors duration-100 ease-out outline-focus-ring focus-visible:-outline-offset-2 focus-visible:outline-2",
          selected ? "bg-active" : "bg-primary hover:bg-primary_hover",
        )}
      >
        {selected && (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-brand-solid" />
        )}

        <div className="flex w-full min-w-0 items-center gap-2">
          <Badge
            type="color"
            size="sm"
            color={CATEGORY_BADGE_COLORS[item.category]}
            className="shrink-0"
          >
            {CATEGORY_LABELS[item.category]()}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
            {item.body}
          </span>
        </div>

        <div className="flex w-full min-w-0 items-center justify-between gap-2 text-xs text-tertiary">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-secondary">{authorName}</span>
            <RelativeTime
              value={item.createdAt}
              timeZone={timeZone}
              plain
              className="shrink-0 text-tertiary"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {item.attachments.length > 0 && (
              <span
                aria-label={m.feedback_inbox_attachments_count({
                  count: item.attachments.length,
                })}
                className="inline-flex shrink-0 items-center gap-0.5 text-tertiary tabular-nums"
              >
                <Paperclip aria-hidden="true" className="size-3.5 shrink-0" />
                <span>{item.attachments.length}</span>
              </span>
            )}
            <span className="inline-flex shrink-0 items-center gap-1 text-tertiary">
              <Dot
                size="sm"
                aria-hidden="true"
                className={cx("shrink-0", STATUS_DOT_COLORS[item.status])}
              />
              <span>{STATUS_LABELS[item.status]()}</span>
            </span>
          </div>
        </div>
      </AriaButton>
    </li>
  );
}

function FeedbackDetailInspector({
  item,
  onBack,
}: {
  item: FeedbackItemSummary;
  onBack: () => void;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const updateStatus = useServerFn(updateFeedbackStatus);
  const [updating, guard] = useSubmitGuard();
  const [error, setError] = useState("");

  const statusItems: SelectItemType[] = FEEDBACK_STATUSES.map((status) => ({
    id: status,
    label: STATUS_LABELS[status](),
  }));

  const authorName = item.author
    ? humanLabel({ displayName: item.author.name })
    : m.feedback_inbox_unknown_user();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center border-b border-secondary px-3 py-2 lg:hidden">
        <Button size="sm" color="tertiary" iconLeading={ArrowLeft} onPress={onBack}>
          {m.feedback_inbox_back()}
        </Button>
      </div>

      <article className="flex min-w-0 flex-1 flex-col gap-5 p-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-secondary pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge type="color" size="sm" color={CATEGORY_BADGE_COLORS[item.category]}>
                {CATEGORY_LABELS[item.category]()}
              </Badge>
              <RelativeTime
                value={item.createdAt}
                timeZone={timeZone}
                className="text-xs text-tertiary"
              />
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold wrap-anywhere text-primary">{authorName}</span>
              {item.author?.email && (
                <span className="text-xs break-all text-tertiary">{item.author.email}</span>
              )}
            </div>
          </div>

          <div className="w-32 shrink-0">
            <Select
              aria-label={m.feedback_status_label()}
              size="sm"
              items={statusItems}
              selectedKey={item.status}
              isDisabled={updating}
              onSelectionChange={(key) => {
                if (!key) return;
                const nextStatus = String(key) as FeedbackStatus;
                if (nextStatus === item.status) return;
                void guard(async () => {
                  setError("");
                  try {
                    await updateStatus({ data: { feedbackId: item.id, status: nextStatus } });
                    await router.invalidate({ sync: true });
                  } catch {
                    setError(m.feedback_status_update_error());
                  }
                });
              }}
            >
              {(option) => <Select.Item id={option.id}>{option.label}</Select.Item>}
            </Select>
          </div>
        </header>

        {error && <Alert color="error" title={error} />}

        <div className="min-w-0">
          <p className="text-sm leading-relaxed whitespace-pre-line wrap-anywhere text-primary">
            {item.body}
          </p>
        </div>

        {item.attachments.length > 0 && (
          <div className="grid gap-2">
            <h2 className="text-xs font-medium text-tertiary">
              {m.feedback_inbox_screenshots({ count: item.attachments.length })}
            </h2>
            <ul className="flex flex-wrap gap-2.5">
              {item.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={attachment.fileName}
                    className="block h-24 w-36 overflow-hidden rounded-lg border border-secondary bg-secondary transition-colors duration-100 ease-out outline-focus-ring hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    <img
                      src={attachment.url}
                      alt={attachment.fileName}
                      className="size-full object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-secondary pt-4 text-xs sm:grid-cols-2">
          <MetaField label={m.feedback_context_submitted()}>
            <time dateTime={item.createdAt} className="text-primary tabular-nums">
              {hydrated
                ? formatDateForDisplay(item.createdAt, timeZone, getLocale(), timeFormat)
                : ""}
            </time>
          </MetaField>

          {item.workspace && (
            <MetaField label={m.feedback_context_workspace()}>
              <span className="wrap-anywhere text-primary">{item.workspace.name}</span>
            </MetaField>
          )}

          {item.pagePath && (
            <MetaField label={m.feedback_context_page()}>
              <span className="block break-all font-mono text-primary">{item.pagePath}</span>
            </MetaField>
          )}

          {item.clientInfo && (
            <MetaField label={m.feedback_context_client()}>
              <span className="block break-all font-mono text-primary">{item.clientInfo}</span>
            </MetaField>
          )}

          {item.routedChannel && (
            <MetaField label={m.feedback_context_routed_channel()}>
              <Link
                to="/w/$workspaceSlug/channel/$channelId"
                params={{
                  workspaceSlug: item.routedChannel.workspaceSlug,
                  channelId: item.routedChannel.channelId,
                }}
                search={{ message: item.routedChannel.messageId }}
                className="inline-flex max-w-full items-center gap-1 rounded-xs font-medium text-brand-secondary underline-offset-2 outline-focus-ring hover:text-brand-secondary_hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span className="truncate">#{item.routedChannel.channelName}</span>
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
              </Link>
            </MetaField>
          )}
        </dl>
      </article>
    </div>
  );
}

function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-tertiary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
