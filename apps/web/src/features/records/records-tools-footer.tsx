import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LineChartUp01 as LineChart, Settings01 as Settings, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { recordsTabSearch } from "./records-sidebar";

/** Sidebar footer: the tools menu (dashboard, stats, settings) and the format-settings hint. */
export function RecordsToolsFooter({
  canManageWeeklyReports,
  formatEditing,
  onNavigate,
}: {
  canManageWeeklyReports: boolean;
  formatEditing: boolean;
  /** Called before navigating to a tool, e.g. to hide the mobile list. */
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const [settingsHintDismissed, setSettingsHintDismissed] = useState(false);
  const [settingsHintVisible, setSettingsHintVisible] = useState(false);

  useEffect(() => {
    if (formatEditing) setSettingsHintVisible(true);
  }, [formatEditing]);

  return (
    <div className="relative border-t border-secondary px-2 py-2">
      {canManageWeeklyReports && settingsHintVisible && !settingsHintDismissed ? (
        <div className="absolute bottom-full left-2 z-20 mb-2 w-60 rounded-xl border border-brand bg-brand-primary px-3 py-2 text-xs text-brand-secondary shadow-sm">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1">
              {m.records_format_settings_hint()}{" "}
              <Link
                to="/w/$workspaceSlug/records/settings"
                params={{ workspaceSlug }}
                search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
                className="font-medium underline"
              >
                {m.records_settings()}
              </Link>
            </p>
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={X}
              tooltip={m.records_format_settings_hint_dismiss()}
              aria-label={m.records_format_settings_hint_dismiss()}
              onClick={() => setSettingsHintDismissed(true)}
              className="size-5 shrink-0"
            />
          </div>
        </div>
      ) : null}
      <Dropdown.Root>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={Settings}
          aria-label={m.records_tools_menu()}
        />
        <Dropdown.Popover placement="top start" className="w-52">
          <Dropdown.Menu
            onAction={(key) => {
              if (key === "dashboard") {
                onNavigate();
                void navigate({
                  to: "/w/$workspaceSlug/records/dashboard",
                  params: { workspaceSlug },
                  search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
                });
              }
              if (key === "stats") {
                onNavigate();
                const now = new Date();
                void navigate({
                  to: "/w/$workspaceSlug/records/stats",
                  params: { workspaceSlug },
                  search: (previous) => ({
                    tab: recordsTabSearch(previous.tab),
                    year: typeof previous.year === "number" ? previous.year : now.getFullYear(),
                    month: typeof previous.month === "number" ? previous.month : now.getMonth() + 1,
                  }),
                });
              }
              if (key === "settings" && canManageWeeklyReports) {
                onNavigate();
                void navigate({
                  to: "/w/$workspaceSlug/records/settings",
                  params: { workspaceSlug },
                  search: (previous) => ({
                    tab: recordsTabSearch(previous.tab),
                  }),
                });
              }
            }}
          >
            <Dropdown.Item id="dashboard" icon={LineChart} label={m.records_dashboard()} />
            <Dropdown.Item id="stats" icon={LineChart} label={m.records_stats()} />
            {canManageWeeklyReports ? (
              <Dropdown.Item id="settings" icon={Settings} label={m.records_settings()} />
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}
