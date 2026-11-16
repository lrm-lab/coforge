import { BookOpen01 } from "@untitledui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { SettingsCard, SettingsField, SettingsGroup } from "#src/components/settings-layout";
import { m } from "#src/paraglide/messages";
import { getMemoryPreference, setMemoryPreference } from "./memory-preference.functions";

export function MemoryPreferenceSettings({ userId }: { userId: string }) {
  const load = useServerFn(getMemoryPreference);
  const save = useServerFn(setMemoryPreference);
  const cache = useQueryClient();
  const key = ["platform-memory-preference", userId];
  const preference = useQuery({ queryKey: key, queryFn: () => load() });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => save({ data: { enabled } }),
    onSuccess: (enabled) => cache.setQueryData(key, enabled),
  });
  return (
    <div className="px-4 pt-8 sm:px-8">
      <SettingsGroup icon={BookOpen01} label={m.settings_memory()}>
        <SettingsCard>
          {preference.isPending ? (
            <p role="status">{m.memory_loading()}</p>
          ) : preference.isError ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-sm text-error-primary">
                {m.memory_error()}
              </p>
              <Button color="secondary" onClick={() => void preference.refetch()}>
                {m.memory_retry()}
              </Button>
            </div>
          ) : (
            <SettingsField
              inline
              label={m.memory_preference_label()}
              description={m.memory_preference_description()}
            >
              <Toggle
                size="md"
                aria-label={m.memory_preference_label()}
                isSelected={preference.data}
                isDisabled={mutation.isPending}
                onChange={(enabled) => mutation.mutate(enabled)}
              />
            </SettingsField>
          )}
          {mutation.isError ? (
            <p role="alert" className="text-sm text-error-primary">
              {m.memory_error()}
            </p>
          ) : null}
          {mutation.isSuccess ? (
            <p role="status" className="text-sm text-secondary">
              {m.memory_preference_saved()}
            </p>
          ) : null}
        </SettingsCard>
      </SettingsGroup>
    </div>
  );
}
