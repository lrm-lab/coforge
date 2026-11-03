import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Globe01, MessageTextSquare01, Monitor01, PauseCircle, Phone01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { Toggle } from "#src/components/base/toggle/toggle";
import { SettingsCard, SettingsField, SettingsGroup } from "#src/components/settings-layout";
import { useAppToast } from "#src/components/ui/toast";
import { isAppError } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { currentBrowserPushEndpoint } from "./browser-push";
import {
  getNotificationSettings,
  sendTestNotificationToDevices,
  updateNotificationSettings,
} from "./notification-settings.functions";
import {
  MOBILE_DELAYS,
  NOTIFICATION_PREVIEW_MODES,
  type MobileDelay,
  type NotificationPreviewMode,
  type NotificationSettingsChange,
} from "./notification-settings.schemas";

const SETTINGS_KEY = ["notification-settings"] as const;
const VERSION_CONFLICT = "notification-settings-version-conflict";

type Loaded = Awaited<ReturnType<typeof getNotificationSettings>>;
type Changes = NotificationSettingsChange["changes"];

const PAUSES = ["30m", "1h", "2h", "tomorrow", "week"] as const;
type Pause = (typeof PAUSES)[number];

/** When a pause picked now ends: a span from now, or tomorrow at 9:00 on this computer's clock. */
export function pauseEnd(pause: Pause, now: Date): Date {
  const minutes = { "30m": 30, "1h": 60, "2h": 120, week: 7 * 24 * 60 } as const;
  if (pause !== "tomorrow") return new Date(now.getTime() + minutes[pause] * 60_000);
  const end = new Date(now);
  end.setDate(end.getDate() + 1);
  end.setHours(9, 0, 0, 0);
  return end;
}

/** A minute of the day as the quiet-hours pickers show it, `HH:MM`. */
export function minuteLabel(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  return `${hours}:${String(minute % 60).padStart(2, "0")}`;
}

/** The quiet-hours pickers' choices: every half hour of the day. */
const HALF_HOURS = Array.from({ length: 48 }, (_, index) => index * 30);

const PAUSE_LABELS: Record<Pause, () => string> = {
  "30m": m.notif_pause_30m,
  "1h": m.notif_pause_1h,
  "2h": m.notif_pause_2h,
  tomorrow: m.notif_pause_tomorrow,
  week: m.notif_pause_week,
};
const PREVIEW_LABELS: Record<NotificationPreviewMode, () => string> = {
  full: m.notif_preview_full,
  sender: m.notif_preview_sender,
  hidden: m.notif_preview_hidden,
};
const MOBILE_LABELS: Record<MobileDelay, () => string> = {
  immediate: m.notif_mobile_immediate,
  inactive: m.notif_mobile_inactive,
  idle_1m: m.notif_mobile_idle_1m,
  idle_2m: m.notif_mobile_idle_2m,
  idle_5m: m.notif_mobile_idle_5m,
  idle_10m: m.notif_mobile_idle_10m,
};
type TestOutcome = "sent" | "failed" | "removed" | "unreachable";
const OUTCOME_LABELS: Record<TestOutcome, () => string> = {
  sent: m.notif_test_sent,
  failed: m.notif_test_failed,
  removed: m.notif_test_removed,
  unreachable: m.notif_test_unreachable,
};

const when = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );

/**
 * The account's notification settings (task #469, Raft's settings.notifications): a pause and
 * quiet hours, what a notification shows and whether it sounds, how long the phone waits while
 * the person is at a computer, and every device that gets them, with a test to all of them. Each
 * change saves at once from the version it was made from; another device's save in between is
 * shown and the change is asked for again.
 */
export function NotificationSettingsPanel() {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const load = useServerFn(getNotificationSettings);
  const update = useServerFn(updateNotificationSettings);
  const sendTest = useServerFn(sendTestNotificationToDevices);
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => load({ data: { endpoint: await currentBrowserPushEndpoint() } }),
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, TestOutcome>>({});

  if (query.isError) return <p className="text-sm text-error-primary">{m.notif_load_failed()}</p>;
  const loaded = query.data;
  if (!loaded) return null;
  const { settings, timeZone, devices } = loaded;

  async function save(changes: Changes) {
    if (saving || !loaded) return;
    setSaving(true);
    // Shown at once; the server's answer (or a re-read) settles it.
    queryClient.setQueryData<Loaded>(SETTINGS_KEY, (current) =>
      current ? { ...current, settings: { ...current.settings, ...changes } } : current,
    );
    try {
      const saved = await update({ data: { expectedVersion: loaded.settings.version, changes } });
      queryClient.setQueryData<Loaded>(SETTINGS_KEY, (current) =>
        current ? { ...current, settings: saved } : current,
      );
    } catch (error) {
      toast.error(
        isAppError(error) && error.errorId === VERSION_CONFLICT
          ? m.notif_save_conflict()
          : m.notif_save_failed(),
      );
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    } finally {
      setSaving(false);
    }
  }

  const paused = settings.pausedUntil && new Date(settings.pausedUntil) > new Date();
  const quiet = settings.quietHours;

  return (
    <>
      <SettingsGroup icon={PauseCircle} label={m.notif_section_pause()}>
        <SettingsCard>
          <SettingsField label={m.notif_pause_title()} description={m.notif_pause_description()}>
            {paused ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-secondary">
                  {m.notif_paused_until({ until: when(settings.pausedUntil!) })}
                </p>
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={saving}
                  onPress={() => void save({ pausedUntil: null })}
                >
                  {m.notif_pause_resume()}
                </Button>
              </div>
            ) : (
              <Select
                aria-label={m.notif_pause_title()}
                className="max-w-xs"
                value="off"
                isDisabled={saving}
                onChange={(key) => {
                  const pause = PAUSES.find((each) => each === key);
                  if (pause) void save({ pausedUntil: pauseEnd(pause, new Date()).toISOString() });
                }}
              >
                <SelectItem id="off" label={m.notif_pause_off()} />
                {PAUSES.map((pause) => (
                  <SelectItem key={pause} id={pause} label={PAUSE_LABELS[pause]()} />
                ))}
              </Select>
            )}
          </SettingsField>
          <SettingsField
            inline
            label={m.notif_quiet_title()}
            description={m.notif_quiet_description({ timeZone })}
          >
            <Toggle
              size="md"
              aria-label={m.notif_quiet_title()}
              isSelected={quiet.enabled}
              isDisabled={saving}
              onChange={(enabled) => void save({ quietHours: { ...quiet, enabled } })}
            />
          </SettingsField>
          {quiet.enabled && (
            <div className="flex flex-wrap items-end gap-3">
              {(["startMinute", "endMinute"] as const).map((end) => (
                <div key={end} className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-secondary">
                    {end === "startMinute" ? m.notif_quiet_from() : m.notif_quiet_to()}
                  </span>
                  <Select
                    aria-label={end === "startMinute" ? m.notif_quiet_from() : m.notif_quiet_to()}
                    className="w-32"
                    value={String(quiet[end])}
                    isDisabled={saving}
                    onChange={(key) => {
                      const minute = Number(key);
                      const other = end === "startMinute" ? quiet.endMinute : quiet.startMinute;
                      // The window needs two ends; picking the other one's time leaves it as is.
                      if (Number.isInteger(minute) && minute !== other)
                        void save({ quietHours: { ...quiet, [end]: minute } });
                    }}
                  >
                    {HALF_HOURS.map((minute) => (
                      <SelectItem key={minute} id={String(minute)} label={minuteLabel(minute)} />
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup icon={MessageTextSquare01} label={m.notif_section_content()}>
        <SettingsCard>
          <SettingsField
            label={m.notif_preview_title()}
            description={m.notif_preview_description()}
          >
            <ButtonGroup
              aria-label={m.notif_preview_title()}
              size="sm"
              selectedKeys={[settings.previewMode]}
              disallowEmptySelection
              isDisabled={saving}
              onSelectionChange={(keys) => {
                const next = NOTIFICATION_PREVIEW_MODES.find((mode) => mode === [...keys][0]);
                if (next && next !== settings.previewMode) void save({ previewMode: next });
              }}
            >
              {NOTIFICATION_PREVIEW_MODES.map((mode) => (
                <ButtonGroupItem key={mode} id={mode}>
                  {PREVIEW_LABELS[mode]()}
                </ButtonGroupItem>
              ))}
            </ButtonGroup>
          </SettingsField>
          <SettingsField
            inline
            label={m.notif_sound_title()}
            description={m.notif_sound_description()}
          >
            <Toggle
              size="md"
              aria-label={m.notif_sound_title()}
              isSelected={settings.sound}
              isDisabled={saving}
              onChange={(sound) => void save({ sound })}
            />
          </SettingsField>
          <SettingsField label={m.notif_mobile_title()} description={m.notif_mobile_description()}>
            <Select
              aria-label={m.notif_mobile_title()}
              className="max-w-sm"
              value={settings.mobileDelay}
              isDisabled={saving}
              onChange={(key) => {
                const next = MOBILE_DELAYS.find((delay) => delay === key);
                if (next && next !== settings.mobileDelay) void save({ mobileDelay: next });
              }}
            >
              {MOBILE_DELAYS.map((delay) => (
                <SelectItem key={delay} id={delay} label={MOBILE_LABELS[delay]()} />
              ))}
            </Select>
          </SettingsField>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup icon={Monitor01} label={m.notif_section_devices()}>
        <SettingsCard>
          <p className="text-sm text-tertiary">{m.notif_devices_description()}</p>
          {devices.length === 0 ? (
            <p className="text-sm text-tertiary">{m.notif_devices_empty()}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-secondary">
              {devices.map((device) => {
                const Icon =
                  device.deviceKind === "mobile"
                    ? Phone01
                    : device.deviceKind === "desktop"
                      ? Monitor01
                      : Globe01;
                const outcome = outcomes[device.id];
                return (
                  <li
                    key={device.id}
                    className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-quaternary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-primary">
                        {device.deviceLabel ??
                          (device.deviceKind === "mobile"
                            ? m.notif_device_mobile()
                            : device.deviceKind === "desktop"
                              ? m.notif_device_desktop()
                              : m.notif_device_browser())}
                        {device.current && (
                          <span className="ml-2 text-xs font-normal text-brand-secondary">
                            {m.notif_device_current()}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-tertiary">
                        {device.lastFailureAt &&
                        (!device.lastSuccessAt || device.lastFailureAt > device.lastSuccessAt)
                          ? m.notif_device_last_failure({ time: when(device.lastFailureAt) })
                          : device.lastSuccessAt
                            ? m.notif_device_last_success({ time: when(device.lastSuccessAt) })
                            : m.notif_device_never()}
                      </p>
                    </div>
                    {outcome && (
                      <span
                        className={cn(
                          "shrink-0 text-xs font-medium",
                          outcome === "sent" ? "text-success-primary" : "text-error-primary",
                        )}
                      >
                        {OUTCOME_LABELS[outcome]()}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div>
            <Button
              size="sm"
              color="secondary"
              isDisabled={testing || devices.length === 0}
              onPress={async () => {
                setTesting(true);
                setOutcomes({});
                try {
                  const result = await sendTest();
                  setOutcomes(
                    Object.fromEntries(result.devices.map((device) => [device.id, device.outcome])),
                  );
                  await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
                } catch {
                  toast.error(m.preferences_browser_notifications_test_error());
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? m.notif_test_sending() : m.notif_test_all()}
            </Button>
          </div>
        </SettingsCard>
      </SettingsGroup>
    </>
  );
}
