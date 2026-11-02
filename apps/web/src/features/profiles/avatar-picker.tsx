import { useState } from "react";
import { RadioGroup } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { AvatarChoice } from "#src/features/avatars/avatar-choice";
import { m } from "#src/paraglide/messages";
import { avatarPresets } from "./avatar-presets";

/**
 * Settings → Account → Change avatar: the platform's pictures, five men then five women, a row
 * each, the current one ringed, as on the first sign-in name step. Saving stores the chosen preset
 * by id; the picture itself already ships with the app.
 */
export function AvatarPicker({
  currentAvatarUrl,
  onSave,
  onClose,
}: {
  currentAvatarUrl: string | null;
  /** Saves the chosen preset as the avatar; rejects when it cannot. */
  onSave: (presetId: string) => Promise<void>;
  /** Back to the profile, saved or not. */
  onClose: () => void;
}) {
  const currentId = avatarPresets.find((preset) => preset.url === currentAvatarUrl)?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(currentId);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const changed = selectedId !== null && selectedId !== currentId;

  async function save() {
    if (!changed) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(selectedId);
      onClose();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  }

  return (
    <div className="w-full px-4 pt-4 pb-8 sm:px-8">
      <header className="flex max-w-2xl flex-wrap items-center justify-between gap-4">
        <h2 className="text-display-xs font-semibold text-primary">
          {m.settings_avatar_picker_title()}
        </h2>
        <div className="flex items-center gap-3">
          <Button type="button" color="secondary" isDisabled={saving} onPress={onClose}>
            {m.settings_profile_cancel()}
          </Button>
          <Button type="button" isDisabled={!changed || saving} onPress={save}>
            {saving ? m.settings_profile_saving() : m.settings_avatar_picker_save()}
          </Button>
        </div>
      </header>
      {failed && (
        <p role="alert" className="mt-4 text-sm text-error-primary">
          {m.settings_avatar_save_error()}
        </p>
      )}

      <RadioGroup
        aria-label={m.settings_avatar_picker_title()}
        value={selectedId}
        onChange={setSelectedId}
        isDisabled={saving}
        orientation="horizontal"
        className="mt-8 grid max-w-2xl grid-cols-5 gap-4 sm:gap-6"
      >
        {avatarPresets.map((preset) => (
          <AvatarChoice
            key={preset.id}
            value={preset.id}
            src={preset.url}
            label={m.settings_avatar_preset_label({ number: preset.number })}
            hideLabel
          />
        ))}
      </RadioGroup>
    </div>
  );
}
