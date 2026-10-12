import { useState } from "react";
import { Radio, RadioGroup } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { avatarPresetFile, avatarPresets } from "./avatar-presets";

/**
 * Settings → Account → Change avatar: the platform's pictures beside a live preview of the one
 * chosen. Saving hands the picture to the same upload an own picture takes.
 */
export function AvatarPicker({
  name,
  currentAvatarUrl,
  onSave,
  onClose,
}: {
  /** The name teammates see, shown beside the preview. */
  name: string;
  currentAvatarUrl: string | null;
  /** Saves the chosen picture as the avatar; rejects when it cannot. */
  onSave: (file: File) => Promise<void>;
  /** Back to the profile, saved or not. */
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const selected = avatarPresets.find((preset) => preset.id === selectedId) ?? null;
  const previewUrl = selected?.url ?? currentAvatarUrl;

  async function save() {
    if (!selected) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(await avatarPresetFile(selected));
      onClose();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  }

  return (
    <div className="w-full px-4 pt-4 pb-8 sm:px-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section className="h-fit rounded-xl border border-secondary p-6">
          <div className="flex items-center justify-between text-sm">
            <h2 className="font-semibold text-primary">{m.settings_avatar_current()}</h2>
            <span className="text-tertiary">{m.settings_avatar_live_preview()}</span>
          </div>
          <div className="mt-6 flex flex-col items-center gap-3">
            <div className="rounded-3xl bg-primary p-1 shadow-lg">
              {previewUrl ? (
                <img src={previewUrl} alt="" className="size-40 rounded-[1.25rem] object-cover" />
              ) : (
                <Avatar
                  size="2xl"
                  className="avatar-profile size-40"
                  alt={name}
                  initials={avatarInitial(name)}
                  contentClassName={avatarToneClassName(name)}
                />
              )}
            </div>
            <p className="min-h-5 text-sm font-semibold text-primary">
              {selected ? m.settings_avatar_preset_label({ number: selected.number }) : ""}
            </p>
          </div>
          <dl className="mt-6 flex flex-col gap-3 border-t border-secondary pt-6 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-tertiary">{m.settings_display_name()}</dt>
              <dd className="min-w-0 break-words text-right font-medium text-primary">{name}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-tertiary">{m.settings_avatar_scope()}</dt>
              <dd className="font-medium text-primary">{m.settings_avatar_scope_all()}</dd>
            </div>
          </dl>
          <p className="mt-6 rounded-lg bg-secondary px-4 py-3 text-sm text-tertiary">
            {m.settings_avatar_scope_note()}
          </p>
        </section>

        <section className="min-w-0">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-display-xs font-semibold text-primary">
                {m.settings_avatar_picker_title()}
              </h2>
              <p className="text-md text-tertiary">
                {m.settings_avatar_picker_count({ count: avatarPresets.length })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button type="button" color="secondary" isDisabled={saving} onPress={onClose}>
                {m.settings_profile_cancel()}
              </Button>
              <Button type="button" isDisabled={!selected || saving} onPress={save}>
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
            className="mt-6 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 xl:grid-cols-6"
          >
            {avatarPresets.map((preset) => (
              <Radio
                key={preset.id}
                value={preset.id}
                className="group flex cursor-pointer flex-col items-center gap-2 outline-hidden"
              >
                {({ isSelected, isFocusVisible }) => (
                  <>
                    <span
                      className={cx(
                        "rounded-2xl p-1 transition-colors",
                        isSelected
                          ? "bg-brand-primary ring-2 ring-focus-ring"
                          : "group-hover:bg-secondary",
                        isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                      )}
                    >
                      <img
                        src={preset.url}
                        alt=""
                        loading="lazy"
                        className="aspect-square w-full rounded-xl object-cover"
                      />
                    </span>
                    <span className="text-xs text-tertiary">
                      {m.settings_avatar_preset_label({ number: preset.number })}
                    </span>
                  </>
                )}
              </Radio>
            ))}
          </RadioGroup>
        </section>
      </div>
    </div>
  );
}
