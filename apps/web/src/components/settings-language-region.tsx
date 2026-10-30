import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { useEffect, useState } from "react";
import { Clock as Clock3, Translate01 as Languages } from "@untitledui/icons";
import {} from "#src/components/layout/page-header";
import { Button } from "#src/components/base/buttons/button";
import {} from "#src/components/base/buttons/button-utility";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import {} from "#src/components/base/toggle/toggle";
import {} from "#src/components/base/checkbox/checkbox";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import {} from "#src/features/workspaces/workspace-members-panel";
import {} from "#src/features/integrations/github-settings";
import {} from "#src/features/apps/apps-settings";
import {} from "#src/features/settings/server-connection-settings";
import {} from "#src/features/settings/experiments-settings";
import {} from "#src/features/settings/settings-navigation-group";
import { isTimeFormat, localeTimeFormat, type TimeFormat } from "#src/lib/time-format";
import {} from "#src/lib/utils";
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsField,
  SettingsGroup,
  SettingsPage,
} from "#src/components/settings-layout";
import { saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";
import {} from "./settings-preferences";
import {} from "./settings-workspace-profile";
import type { Locale, SettingsContentProps } from "./settings-content";

export function LanguageRegionSettings({
  locale,
  timeZone,
  timeFormat,
  onLocaleChange,
  onDateTimeSave,
}: Pick<
  SettingsContentProps,
  "locale" | "timeZone" | "timeFormat" | "onLocaleChange" | "onDateTimeSave"
>) {
  const timeZoneOptions = getTimeZoneOptions(m.preferences_system());
  const [draftLocale, setDraftLocale] = useState<Locale>(locale);
  // Until the viewer saves a choice, the page shows the cycle their language already uses.
  const effectiveTimeFormat = timeFormat ?? localeTimeFormat(locale);
  const [draftTimeZone, setDraftTimeZone] = useState(timeZone ?? "");
  const [draftTimeFormat, setDraftTimeFormat] = useState<TimeFormat>(effectiveTimeFormat);
  const [saving, guard] = useSubmitGuard();
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  useEffect(() => {
    setDraftTimeZone(timeZone ?? "");
    setDraftTimeFormat(effectiveTimeFormat);
  }, [timeZone, effectiveTimeFormat]);

  const dateTimeChanged =
    draftTimeZone !== (timeZone ?? "") || draftTimeFormat !== effectiveTimeFormat;

  function saveDateTime() {
    void guard(async () => {
      setSaveError(null);
      try {
        await onDateTimeSave({
          timeZone: draftTimeZone || null,
          // Keep following the language when the viewer left the format untouched.
          timeFormat:
            timeFormat === null && draftTimeFormat === effectiveTimeFormat ? null : draftTimeFormat,
        });
      } catch (cause) {
        setSaveError(saveErrorFrom(m.settings_save_error(), cause));
      }
    });
  }

  return (
    <SettingsPage>
      <SettingsGroup icon={Languages} label={m.language_region_language_group()}>
        <SettingsCard>
          <SettingsField
            label={m.language_region_display_language()}
            description={m.language_region_display_language_description()}
          >
            <Select
              aria-label={m.language_region_display_language()}
              className="max-w-sm"
              value={draftLocale}
              onChange={(key) => {
                if (key === "en" || key === "zh-CN") setDraftLocale(key);
              }}
            >
              <SelectItem id="en" label={m.preferences_english()} />
              <SelectItem id="zh-CN" label={m.preferences_chinese()} />
            </Select>
          </SettingsField>
          <SettingsCardFooter>
            <Button
              type="button"
              size="sm"
              isDisabled={draftLocale === locale}
              onPress={() => onLocaleChange(draftLocale)}
            >
              {m.settings_group_save()}
            </Button>
          </SettingsCardFooter>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup icon={Clock3} label={m.language_region_date_time_group()}>
        <SettingsCard>
          <SettingsField
            label={m.preferences_time_zone()}
            description={m.language_region_time_zone_description()}
          >
            <Select
              aria-label={m.preferences_time_zone()}
              className="max-w-sm"
              items={timeZoneOptions}
              value={draftTimeZone || "system"}
              onChange={(key) => {
                if (key !== null) setDraftTimeZone(key === "system" ? "" : String(key));
              }}
            >
              {(option) => <SelectItem id={option.id} label={option.label} />}
            </Select>
          </SettingsField>
          <SettingsField
            label={m.language_region_time_format()}
            description={m.language_region_time_format_description()}
          >
            <ButtonGroup
              aria-label={m.language_region_time_format()}
              size="sm"
              selectedKeys={[draftTimeFormat]}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (isTimeFormat(next)) setDraftTimeFormat(next);
              }}
            >
              <ButtonGroupItem id="12h">{m.language_region_time_format_12h()}</ButtonGroupItem>
              <ButtonGroupItem id="24h">{m.language_region_time_format_24h()}</ButtonGroupItem>
            </ButtonGroup>
          </SettingsField>
          <SettingsCardFooter error={saveError}>
            <Button
              type="button"
              size="sm"
              isDisabled={saving || !dateTimeChanged}
              onPress={saveDateTime}
            >
              {saving ? m.settings_group_saving() : m.settings_group_save()}
            </Button>
          </SettingsCardFooter>
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}

interface TimeZoneOption {
  id: string;
  label: string;
  offsetMinutes: number;
}

const TIME_ZONES = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
  ]),
);

function getTimeZoneOptions(systemLabel: string): TimeZoneOption[] {
  return [
    {
      id: "system",
      label: systemLabel,
      offsetMinutes: 0,
    },
    ...TIME_ZONE_OPTIONS,
  ];
}

const TIME_ZONE_OPTIONS = TIME_ZONES.map((timeZone) => {
  const offset = getUtcOffset(timeZone);
  const city = (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
  const label = `(${offset.label}) ${city} - ${timeZone}`;

  return {
    id: timeZone,
    label,
    offsetMinutes: offset.minutes,
  };
}).sort(
  (left, right) =>
    left.offsetMinutes - right.offsetMinutes || left.label.localeCompare(right.label),
);

function getUtcOffset(timeZone: string) {
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  const match = timeZoneName?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);

  if (!match?.[1] || !match[2] || !match[3]) {
    return { label: "UTC+00:00", minutes: 0 };
  }

  const sign = match[1] === "+" ? 1 : -1;
  return {
    label: `UTC${match[1]}${match[2]}:${match[3]}`,
    minutes: sign * (Number(match[2]) * 60 + Number(match[3])),
  };
}
