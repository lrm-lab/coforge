import { useMutation } from "@tanstack/react-query";
import { Clock as Clock3, Translate01 as Languages } from "@untitledui/icons";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { isTimeFormat, localeTimeFormat, type TimeFormat } from "#src/lib/time-format";
import {
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsPage,
} from "#src/components/settings-layout";
import { saveErrorFrom, SaveErrorMessage } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";
import type { SettingsContentProps } from "./settings-content";

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
  const saveOptions = { scope: { id: "language-region" }, networkMode: "always" } as const;
  const language = useMutation({ ...saveOptions, mutationFn: onLocaleChange });
  const zone = useMutation({
    ...saveOptions,
    mutationFn: (timeZone: string | null) => onDateTimeSave({ timeZone }),
  });
  const format = useMutation({
    ...saveOptions,
    mutationFn: (timeFormat: TimeFormat) => onDateTimeSave({ timeFormat }),
  });
  const selectedZone = zone.isPending ? zone.variables : timeZone;
  const selectedFormat = format.isPending
    ? format.variables
    : (timeFormat ?? localeTimeFormat(locale));

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
              value={language.isPending ? language.variables : locale}
              isDisabled={language.isPending}
              onChange={(key) => {
                if ((key === "en" || key === "zh-CN") && key !== locale) language.mutate(key);
              }}
            >
              <SelectItem id="en" label={m.preferences_english()} />
              <SelectItem id="zh-CN" label={m.preferences_chinese()} />
            </Select>
          </SettingsField>
          {language.isError && (
            <SaveErrorMessage error={saveErrorFrom(m.settings_save_error(), language.error)} />
          )}
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
              value={selectedZone ?? "system"}
              isDisabled={language.isPending}
              onChange={(key) => {
                if (key !== null && key !== (selectedZone ?? "system"))
                  zone.mutate(key === "system" ? null : String(key));
              }}
            >
              {(option) => <SelectItem id={option.id} label={option.label} />}
            </Select>
          </SettingsField>
          {zone.isError && (
            <SaveErrorMessage error={saveErrorFrom(m.settings_save_error(), zone.error)} />
          )}
          <SettingsField
            label={m.language_region_time_format()}
            description={m.language_region_time_format_description()}
          >
            <ButtonGroup
              aria-label={m.language_region_time_format()}
              size="sm"
              selectedKeys={[selectedFormat]}
              isDisabled={language.isPending}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (isTimeFormat(next) && next !== selectedFormat) format.mutate(next);
              }}
            >
              <ButtonGroupItem id="12h">{m.language_region_time_format_12h()}</ButtonGroupItem>
              <ButtonGroupItem id="24h">{m.language_region_time_format_24h()}</ButtonGroupItem>
            </ButtonGroup>
          </SettingsField>
          {format.isError && (
            <SaveErrorMessage error={saveErrorFrom(m.settings_save_error(), format.error)} />
          )}
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
