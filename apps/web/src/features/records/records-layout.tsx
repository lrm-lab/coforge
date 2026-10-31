import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronLeft,
  Edit01 as Edit,
  File02 as FileText,
  Plus,
  SearchLg as Search,
} from "@untitledui/icons";

import { UnreadDot } from "#src/components/ui/unread-marker";
import { PageHeader } from "#src/components/layout/page-header";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { createRecordNote, type loadRecordsCatalog } from "./records.functions";
import {
  defaultRecordsSectionOpen,
  recallRecordsSidebarExpand,
  rememberRecordsSidebarExpand,
  type RecordsSidebarExpandSnapshot,
  type RecordsSidebarSectionId,
} from "./records-sidebar-expand";
import { FormatChipSlot } from "./records-format-chip";
import { RecordsToolsFooter } from "./records-tools-footer";
import { RecordsMemberWeeksSection } from "./records-member-weeks-section";
import { useRecordsMemberWeeks } from "./use-records-member-weeks";
import { CollapsibleSection, RecordLink, SidebarMore, WeekBadge } from "./records-sidebar-parts";
import { matchesQuery, recordsTabSearch, sidebarPreview, type RecordsTab } from "./records-sidebar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { useRecordRefresh } from "./use-record-refresh";

export type { RecordsTab };
export type RecordsPanel = "settings" | "stats" | "dashboard";
export type RecordsCatalog = Awaited<ReturnType<typeof loadRecordsCatalog>>;

const BackToRecordsContext = createContext<(() => void) | undefined>(undefined);

const FormatEditHintContext = createContext<(editing: boolean) => void>(() => {});

export function useFormatEditHint() {
  return useContext(FormatEditHintContext);
}

export function RecordsLayout({
  catalog,
  selectedRecordId,
  selectedWeekKey,
  selectedPanel,
  tab,
  onTabChange,
  children,
  detailOpen,
}: {
  catalog: RecordsCatalog;
  selectedRecordId?: string;
  /** `year-week` key when the week empty route (or landing) is active. */
  selectedWeekKey?: string;
  /** True only when the URL is a record or panel — keeps the mobile list on `/records`. */
  detailOpen?: boolean;
  selectedPanel?: RecordsPanel | null;
  tab: RecordsTab;
  onTabChange: (tab: RecordsTab) => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const refresh = useRecordRefresh();
  const workspaceSlug = useWorkspaceSlug();
  const workspaceId = useCurrentWorkspaceId();
  const createNote = useServerFn(createRecordNote);
  const recordOpen = detailOpen ?? Boolean(selectedRecordId || selectedPanel || selectedWeekKey);
  const [showMobileList, setShowMobileList] = useState(!recordOpen);
  const [query, setQuery] = useState("");
  const memberWeeks = useRecordsMemberWeeks(catalog, query, tab === "weekly", {
    recordId: selectedRecordId,
    weekKey: selectedWeekKey,
  });
  const sectionDefaults = useMemo(() => {
    const context = {
      tab,
      selectedRecordId,
      selectedWeekKey,
      favoriteIds: catalog.favorites.map((item) => item.id),
      myReportIds: catalog.myReports.map((item) => item.id),
      memberWeeks: memberWeeks.weeks,
    };
    return {
      favorites: defaultRecordsSectionOpen("favorites", context),
      myReports: defaultRecordsSectionOpen("myReports", context),
      members: defaultRecordsSectionOpen("members", context),
      notes: defaultRecordsSectionOpen("notes", context),
    };
  }, [
    tab,
    selectedRecordId,
    selectedWeekKey,
    catalog.favorites,
    catalog.myReports,
    memberWeeks.weeks,
  ]);
  /** One entry section at a time; session storage restores the last operated section. */
  const [activeSection, setActiveSection] = useState<RecordsSidebarSectionId | undefined>(
    undefined,
  );
  const [favoritesOpen, setFavoritesOpen] = useState(sectionDefaults.favorites);
  const [favoritesExpanded, setFavoritesExpanded] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [formatEditing, setFormatEditing] = useState(false);
  const [myReportsOpen, setMyReportsOpen] = useState(sectionDefaults.myReports);
  const [membersOpen, setMembersOpen] = useState(sectionDefaults.members);
  const [notesOpen, setNotesOpen] = useState(sectionDefaults.notes);
  const [expandedWeeks, setExpandedWeeks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const listHidden = recordOpen && !showMobileList;

  const applyActiveSection = useCallback((section: RecordsSidebarSectionId) => {
    setActiveSection(section);
    setFavoritesOpen(section === "favorites");
    setMyReportsOpen(section === "myReports");
    setMembersOpen(section === "members");
    setNotesOpen(section === "notes");
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const stored = recallRecordsSidebarExpand(workspaceId);
    if (!stored) return;
    if (stored.activeSection) applyActiveSection(stored.activeSection);
    if (Object.keys(stored.weeks).length > 0) setExpandedWeeks(stored.weeks);
  }, [workspaceId, applyActiveSection]);

  const persistExpand = useCallback(
    (next: {
      activeSection?: RecordsSidebarSectionId | undefined;
      weeks?: Record<string, boolean>;
    }) => {
      if (!workspaceId) return;
      const snapshot: RecordsSidebarExpandSnapshot = {
        activeSection: next.activeSection !== undefined ? next.activeSection : activeSection,
        weeks: next.weeks ?? expandedWeeks,
      };
      rememberRecordsSidebarExpand(workspaceId, snapshot);
    },
    [workspaceId, activeSection, expandedWeeks],
  );

  const enterSection = useCallback(
    (section: RecordsSidebarSectionId) => {
      applyActiveSection(section);
      persistExpand({ activeSection: section });
    },
    [applyActiveSection, persistExpand],
  );

  const filteredFavorites = useMemo(
    () => catalog.favorites.filter((item) => matchesQuery(item.title, query)),
    [catalog.favorites, query],
  );
  const previewFavorites = useMemo(
    () => sidebarPreview(filteredFavorites, Boolean(query) || favoritesExpanded),
    [filteredFavorites, query, favoritesExpanded],
  );
  const filteredMyReports = useMemo(
    () => catalog.myReports.filter((item) => matchesQuery(item.title, query)),
    [catalog.myReports, query],
  );
  const myReportsUnread = catalog.myReports.some((item) => item.unread);
  // A report older than the catalog's page is listed once its week is read: its section opens
  // then, as `sectionDefaults` opens it at once for one listed already, unless another is open.
  const wasListed = useRef(memberWeeks.selectionListed);
  useEffect(() => {
    const listedNow = memberWeeks.selectionListed && !wasListed.current;
    wasListed.current = memberWeeks.selectionListed;
    if (listedNow && !favoritesOpen && !myReportsOpen) setMembersOpen(true);
  }, [memberWeeks.selectionListed]);
  const filteredNotes = useMemo(
    () =>
      catalog.notes.filter(
        (note) => matchesQuery(note.title, query) || matchesQuery(note.preview, query),
      ),
    [catalog.notes, query],
  );

  async function openCreatedRecord(recordId: string) {
    setShowMobileList(false);
    await refresh.records();
    void navigate({
      to: "/w/$workspaceSlug/records/$recordId",
      params: { workspaceSlug, recordId },
      search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
    });
  }

  async function onCreateNote() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createNote({ data: { title: m.records_note_untitled() } });
      setNotesOpen(true);
      void openCreatedRecord(result.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormatEditHintContext value={setFormatEditing}>
      <main
        data-panel-cards
        className="flex h-full min-w-0 flex-col bg-primary lg:flex-row lg:gap-2 lg:bg-transparent"
      >
        <nav
          aria-label={m.records_list_label()}
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary lg:flex lg:w-72 lg:flex-none lg:rounded-xl",
            listHidden ? "hidden" : "flex w-full",
          )}
        >
          <PageHeader heading={m.records_title()} />
          <Tabs
            selectedKey={tab}
            onSelectionChange={(key) => {
              if (key === "weekly" || key === "notes") onTabChange(key);
            }}
            className="min-h-0 flex-1"
          >
            <div className="space-y-3 px-3 pt-3">
              <Input
                type="search"
                size="sm"
                icon={Search}
                aria-label={m.records_search_placeholder()}
                value={query}
                onChange={setQuery}
                placeholder={m.records_search_placeholder()}
              />
              <TabList aria-label={m.records_title()} type="underline" className="gap-4 px-1">
                <Tab id="weekly" icon={FileText}>
                  {m.records_tab_weekly()}
                </Tab>
                <Tab id="notes" icon={Edit}>
                  {m.records_tab_notes()}
                </Tab>
              </TabList>
            </div>

            <TabPanel id={tab} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {tab === "weekly" ? (
                <div className="space-y-5">
                  <div className="space-y-2">
                    {catalog.formatChips.map((chip) => (
                      <FormatChipSlot
                        key={chip.settingsId ?? `disabled-${chip.year}-${chip.week}`}
                        chip={chip}
                        distinguishSettingsName={
                          catalog.formatChips.filter((row) => row.interactive).length > 1
                        }
                        selected={Boolean(
                          chip.interactive && chip.id && chip.id === selectedRecordId,
                        )}
                        onSelect={() => setShowMobileList(false)}
                      />
                    ))}
                  </div>

                  <CollapsibleSection
                    title={m.records_section_favorites()}
                    open={favoritesOpen}
                    onOpenChange={(open) => {
                      if (open) enterSection("favorites");
                      else setFavoritesOpen(false);
                    }}
                  >
                    {filteredFavorites.length === 0 ? null : (
                      <ul className="space-y-0.5">
                        {previewFavorites.visible.map((item) => (
                          <li key={item.id}>
                            <RecordLink
                              recordId={item.id}
                              selected={item.id === selectedRecordId}
                              onSelect={() => {
                                enterSection("favorites");
                                setShowMobileList(false);
                              }}
                            >
                              <IdentityAvatar
                                size="sm"
                                name={item.author.displayName}
                                alt={item.author.displayName}
                                src={item.author.avatarUrl}
                              />
                              <span className="truncate">{item.title}</span>
                            </RecordLink>
                          </li>
                        ))}
                      </ul>
                    )}
                    <SidebarMore
                      hiddenCount={previewFavorites.hiddenCount}
                      onExpand={() => setFavoritesExpanded(true)}
                    />
                  </CollapsibleSection>

                  <CollapsibleSection
                    title={m.records_section_mine()}
                    open={myReportsOpen}
                    onOpenChange={(open) => {
                      if (open) enterSection("myReports");
                      else setMyReportsOpen(false);
                    }}
                    marker={
                      myReportsUnread ? (
                        <span role="img" aria-label={m.records_report_unread_badge()}>
                          <UnreadDot />
                        </span>
                      ) : null
                    }
                  >
                    {filteredMyReports.length === 0 ? null : (
                      <ul className="space-y-0.5">
                        {filteredMyReports.map((item) => {
                          const unread = item.unread;
                          const sent = item.status === "submitted" || item.status === "shared";
                          return (
                            <li key={item.id}>
                              <RecordLink
                                recordId={item.id}
                                selected={item.id === selectedRecordId}
                                onSelect={() => {
                                  enterSection("myReports");
                                  setShowMobileList(false);
                                }}
                                className={cn(unread && "font-semibold")}
                              >
                                <WeekBadge week={item.week} className="size-6" />
                                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                {sent ? (
                                  <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-tertiary">
                                    {m.records_report_sent_badge()}
                                  </span>
                                ) : unread ? (
                                  <span
                                    role="img"
                                    aria-label={m.records_report_unread_badge()}
                                    className="ml-auto"
                                  >
                                    <UnreadDot />
                                  </span>
                                ) : null}
                              </RecordLink>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CollapsibleSection>

                  <RecordsMemberWeeksSection
                    weeks={memberWeeks.weeks}
                    people={memberWeeks.people}
                    hasMore={memberWeeks.hasMore}
                    loadingMore={memberWeeks.loadingMore}
                    loadFailed={memberWeeks.loadFailed}
                    onLoadMore={memberWeeks.loadMore}
                    query={query}
                    selectedRecordId={selectedRecordId}
                    selectedWeekKey={selectedWeekKey}
                    expandedWeeks={expandedWeeks}
                    onExpandedWeekChange={(weekKey, expanded) => {
                      const weeks = { ...expandedWeeks, [weekKey]: expanded };
                      setExpandedWeeks(weeks);
                      persistExpand({ weeks });
                    }}
                    showAll={membersExpanded}
                    onShowAll={() => setMembersExpanded(true)}
                    open={membersOpen}
                    onOpenChange={(open) => {
                      if (open) enterSection("members");
                      else setMembersOpen(false);
                    }}
                    onSelect={() => {
                      enterSection("members");
                      setShowMobileList(false);
                    }}
                  />
                </div>
              ) : (
                <CollapsibleSection
                  title={m.records_notes_mine()}
                  open={notesOpen}
                  onOpenChange={(open) => {
                    if (open) enterSection("notes");
                    else setNotesOpen(false);
                  }}
                  actions={
                    <ButtonUtility
                      size="sm"
                      color="tertiary"
                      icon={Plus}
                      aria-label={m.records_add_note()}
                      isDisabled={busy}
                      onClick={() => void onCreateNote()}
                    />
                  }
                >
                  {filteredNotes.length === 0 ? (
                    <p className="px-1 py-4 text-sm text-tertiary">{m.records_notes_empty()}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredNotes.map((note) => (
                        <li key={note.id}>
                          <RecordLink
                            recordId={note.id}
                            selected={note.id === selectedRecordId}
                            onSelect={() => {
                              enterSection("notes");
                              setShowMobileList(false);
                            }}
                          >
                            <IdentityAvatar
                              size="sm"
                              name={catalog.actorDisplayName}
                              alt={catalog.actorDisplayName}
                              src={catalog.actorAvatarUrl}
                            />
                            <span className="truncate">{note.title}</span>
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleSection>
              )}
            </TabPanel>

            <RecordsToolsFooter
              canManageWeeklyReports={catalog.canManageWeeklyReports}
              formatEditing={formatEditing}
              onNavigate={() => setShowMobileList(false)}
            />
          </Tabs>
        </nav>

        <section
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary lg:flex lg:rounded-xl",
            listHidden ? "flex" : "hidden",
          )}
        >
          <BackToRecordsContext value={() => setShowMobileList(true)}>
            {children}
          </BackToRecordsContext>
        </section>
      </main>
    </FormatEditHintContext>
  );
}

export function BackToRecords() {
  const back = useContext(BackToRecordsContext);
  if (!back) return null;
  return (
    <ButtonUtility
      size="sm"
      color="tertiary"
      icon={ChevronLeft}
      className="lg:hidden"
      aria-label={m.controls_back()}
      onClick={back}
    />
  );
}

/** Back control when arriving from a key-point `@source` link (`?returnTo=`). */
export function RecordsKeyPointReturnBack({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      color="link-color"
      iconLeading={ChevronLeft}
      onPress={() => {
        void router.navigate({ href: returnTo });
      }}
    >
      {m.records_key_points_back_to_report()}
    </Button>
  );
}
