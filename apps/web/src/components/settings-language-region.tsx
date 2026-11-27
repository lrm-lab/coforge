import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Clock as Clock3, Translate01 as Languages } from "@untitledui/icons";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { EntityPickerField } from "#src/features/pickers/entity-picker-field";
import { isTimeFormat, localeTimeFormat, type TimeFormat } from "#src/lib/time-format";
import {
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsPage,
} from "#src/components/settings-layout";
import { saveErrorFrom, SaveErrorMessage } from "#src/components/save-error";
import { buildTimeZonePickerOptions } from "#src/features/settings/time-zone-options";
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
  const systemLabel = m.preferences_system();
  const timeZoneOptions = useMemo(
    () => buildTimeZonePickerOptions({ locale, systemLabel, selectedZone }),
    [locale, systemLabel, selectedZone],
  );

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
            <EntityPickerField
              className="max-w-sm"
              label={m.preferences_time_zone()}
              searchPlaceholder={m.language_region_time_zone_search()}
              options={timeZoneOptions}
              selectedKey={selectedZone ?? "system"}
              isDisabled={language.isPending}
              onSelect={(key) => {
                zone.mutate(key === "system" ? null : key);
              }}
            />
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
