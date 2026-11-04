import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Globe01, MessageTextSquare01, Monitor01, PauseCircle, Phone01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { Toggle } from "#src/components/base/toggle/toggle";
import { SettingsCard, SettingsField, SettingsGroup } from "#src/components/settings-layout";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { currentBrowserPushEndpoint } from "./browser-push";
import {
  customPauseEnd,
  localInputValue,
  PAUSES,
  pauseEnd,
  type Pause,
} from "./notification-pause";
import {
  getNotificationSettings,
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
  custom: m.notif_pause_custom,
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

/** Why a device's last notification failed, as the person can act on it. */
function failureReason(reason: string | null): string {
  if (reason === "removed") return m.notif_failure_removed();
  if (reason === "unreachable") return m.notif_failure_unreachable();
  return m.notif_failure_failed();
}

const when = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );

/** A device as the page names it: its own label, or what kind of device it is. */
function deviceName(device: { deviceKind: string | null; deviceLabel: string | null }): string {
  if (device.deviceLabel && device.deviceLabel !== "Browser") return device.deviceLabel;
  if (device.deviceKind === "mobile") return m.notif_device_mobile();
  if (device.deviceKind === "desktop") return m.notif_device_desktop();
  return m.notif_device_browser();
}

/** A device's last delivery: when it last failed and why, when it last arrived, or never. */
function deliveryLine(device: {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}): string {
  if (
    device.lastFailureAt &&
    (!device.lastSuccessAt || device.lastFailureAt > device.lastSuccessAt)
  )
    return m.notif_device_last_failure_reason({
      time: when(device.lastFailureAt),
      reason: failureReason(device.lastFailureReason),
    });
  if (device.lastSuccessAt)
    return m.notif_device_last_success({ time: when(device.lastSuccessAt) });
  return m.notif_device_never();
}

/**
 * The account's notification settings (task #469, in the order of Raft's settings.notifications):
 * this device, its last delivery and a test to it; a pause (a span, or a time of one's own) and
 * quiet hours; what a notification shows and whether it sounds, and how long the phone waits
 * while the person is at a computer. Each change saves at once from the version it was made from;
 * another device's save in between is shown and the change is asked for again.
 */
export function NotificationSettingsPanel({
  enabled,
  onTest,
}: {
  /** Whether message notifications are on at all; off, these settings do nothing. */
  enabled: boolean;
  /** Sends this browser a test notification; true once it is sent (a failure says why itself). */
  onTest: () => Promise<boolean>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const load = useServerFn(getNotificationSettings);
  const update = useServerFn(updateNotificationSettings);
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => load({ data: { endpoint: await currentBrowserPushEndpoint() } }),
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  /** A custom pause being picked: the input's value, or null while none is. */
  const [until, setUntil] = useState<string | null>(null);

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
  const here = devices.find((device) => device.current);
  const HereIcon =
    here?.deviceKind === "mobile" ? Phone01 : here?.deviceKind === "desktop" ? Monitor01 : Globe01;
  const customEnd = until === null ? null : customPauseEnd(until, new Date());

  return (
    <>
      {!enabled && (
        <p
          role="note"
          className="rounded-lg border border-secondary bg-secondary px-4 py-3 text-sm text-secondary"
        >
          {m.notif_off_note()}
        </p>
      )}
      <SettingsGroup icon={HereIcon} label={m.notif_section_this_device()}>
        <SettingsCard>
          <SettingsField
            inline
            label={here ? deviceName(here) : m.notif_this_device_none()}
            description={here ? deliveryLine(here) : m.notif_this_device_none_hint()}
          >
            <Button
              size="sm"
              color="secondary"
              isDisabled={testing || !enabled || !here}
              onPress={async () => {
                setTesting(true);
                setTested(false);
                try {
                  setTested(await onTest());
                  await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? m.notif_test_sending() : m.notif_test_send()}
            </Button>
          </SettingsField>
          {tested && (
            <p role="status" className="-mt-3 text-sm text-tertiary">
              {m.notif_test_sent_hint()}
            </p>
          )}
        </SettingsCard>
      </SettingsGroup>
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
              <div className="flex flex-col gap-3">
                <Select
                  aria-label={m.notif_pause_title()}
                  className="max-w-xs"
                  value={until === null ? "off" : "custom"}
                  isDisabled={saving}
                  onChange={(key) => {
                    const pause = PAUSES.find((each) => each === key);
                    if (pause === "custom") {
                      setUntil(localInputValue(pauseEnd("tomorrow", new Date())));
                      return;
                    }
                    setUntil(null);
                    if (pause)
                      void save({ pausedUntil: pauseEnd(pause, new Date()).toISOString() });
                  }}
                >
                  <SelectItem id="off" label={m.notif_pause_off()} />
                  {PAUSES.map((pause) => (
                    <SelectItem key={pause} id={pause} label={PAUSE_LABELS[pause]()} />
                  ))}
                </Select>
                {until !== null && (
                  <div className="flex flex-wrap items-start gap-3">
                    <Input
                      type="datetime-local"
                      label={m.notif_pause_custom_label()}
                      className="w-60"
                      value={until}
                      onChange={setUntil}
                      isInvalid={customEnd === null}
                      hint={customEnd === null ? m.notif_pause_custom_invalid() : undefined}
                    />
                    <Button
                      size="md"
                      color="primary"
                      className="mt-6"
                      isDisabled={saving || customEnd === null}
                      onPress={() => {
                        if (!customEnd) return;
                        setUntil(null);
                        void save({ pausedUntil: customEnd.toISOString() });
                      }}
                    >
                      {m.notif_pause_apply()}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </SettingsField>
          <SettingsField
            inline
            label={m.notif_quiet_title()}
            description={m.notif_quiet_description()}
          >
            <Toggle
              size="md"
              aria-label={m.notif_quiet_title()}
              isSelected={quiet.enabled}
              isDisabled={saving}
              onChange={(enabled) => void save({ quietHours: { ...quiet, enabled } })}
            />
          </SettingsField>
          {/* The zone quiet hours read is the one "Language and region" sets; it opens there. */}
          <p className="-mt-3 text-sm text-tertiary">
            {m.notif_time_zone_label()}
            <Link
              to="/w/$workspaceSlug/settings"
              params={{ workspaceSlug }}
              search={{ section: "language-region" }}
              className="rounded-sm font-medium text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
            >
              {timeZone}
            </Link>
          </p>
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
    </>
  );
}
