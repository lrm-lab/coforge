import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useHydrated } from "@tanstack/react-router";
import { useReducedMotion } from "motion/react";
import { Check } from "@untitledui/icons";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import AnimatedGradient from "#src/components/spell/animated-gradient";
import { heroGradient, useWebGl2 } from "#src/features/landing/landing-brand-panel";
import { RadioGroup } from "react-aria-components";
import { AvatarChoice } from "#src/features/avatars/avatar-choice";
import { avatarPresets } from "#src/features/profiles/avatar-presets";
import { Label } from "#src/components/base/input/label";
import { CreatedAgentFaces } from "#src/features/agents/created-agent-faces";
import profileBanner from "#src/features/profiles/profile-banner.webp?inline";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Badge, BadgeWithIcon } from "#src/components/base/badges/badges";
import { TextArea } from "#src/components/base/textarea/textarea";
import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  type PersonNameProblem,
} from "#src/features/profiles/person-name";
import { formatCalendarDate } from "#src/lib/dates";
import { SaveErrorMessage, saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";
import type { SettingsContentProps } from "./settings-content";

/** The signed-in person as Settings → Account shows them. */
export type AccountProfile = {
  id: string;
  /** The name teammates see: the display name. */
  name: string;
  /** Null until the person has been asked for it. */
  displayName: string | null;
  /** Null for an account made with a phone number alone. */
  email: string | null;
  /** Whether the identity provider verified `email`; null until it has said. */
  emailVerified: boolean | null;
  /** E.164; null when the provider reported none. */
  phone: string | null;
  /** Whether the identity provider verified `phone`; null until it has said. */
  phoneVerified: boolean | null;
  description: string;
  avatarUrl: string | null;
  /** False while `avatarUrl` is only the default cartoon. */
  hasAvatar: boolean;
  /** When the account was created, as an ISO instant. */
  joinedAt: string;
};

export function AccountSettings({
  profile,
  createdAgents,
  locale,
  timeZone,
  onProfileSave,
  onAvatarUpload,
  onAvatarPresetChoose,
  onAvatarRemove,
}: SettingsContentProps) {
  const hydrated = useHydrated();
  const gradientReady = useWebGl2();
  const reducedMotion = useReducedMotion() ?? false;
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [description, setDescription] = useState(profile.description);
  const [saving, guard] = useSubmitGuard();
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  // A platform picture chosen in the form, saved with the rest of it like an uploaded one.
  const [pendingPresetId, setPendingPresetId] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Show the just-picked image immediately, before it is uploaded on Save. Without this the
  // preview keeps showing the saved `profile.avatarUrl` until a save round-trips, which reads as
  // "the avatar didn't change". Object URLs must be revoked to avoid leaking the blob.
  const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingAvatar) {
      setPendingAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingAvatar);
    setPendingAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAvatar]);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDisplayName(profile.displayName ?? "");
      setDescription(profile.description);
    }
  }, [editing, profile.displayName, profile.description]);

  function startEditing() {
    setDisplayName(profile.displayName ?? "");
    setDescription(profile.description);
    setPendingAvatar(null);
    setPendingPresetId(null);
    setRemoveAvatar(false);
    setSaveError(null);
    setSaveSuccess(false);
    setEditing(true);
  }

  function cancelEditing() {
    setDisplayName(profile.displayName ?? "");
    setDescription(profile.description);
    setPendingAvatar(null);
    setPendingPresetId(null);
    setRemoveAvatar(false);
    setEditing(false);
  }

  async function save() {
    await guard(async () => {
      setSaveError(null);
      let avatarSaved = false;
      try {
        if (pendingAvatar) {
          await onAvatarUpload(pendingAvatar);
          avatarSaved = true;
          setPendingAvatar(null);
        } else if (pendingPresetId) {
          await onAvatarPresetChoose(pendingPresetId);
          avatarSaved = true;
          setPendingPresetId(null);
        } else if (removeAvatar) {
          await onAvatarRemove();
          avatarSaved = true;
          setRemoveAvatar(false);
        }
        if (profileTextChanged) await onProfileSave({ displayName, description });
        setSaveSuccess(true);
        setEditing(false);
      } catch (cause) {
        const message = avatarSaved
          ? m.settings_profile_save_partial_error()
          : avatarChanged
            ? m.settings_avatar_save_error()
            : m.settings_profile_save_error();
        setSaveError(saveErrorFrom(message, cause));
      }
    });
  }

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPendingAvatar(file);
    setPendingPresetId(null);
    setRemoveAvatar(false);
  }

  function choosePreset(presetId: string) {
    setPendingPresetId(presetId);
    setPendingAvatar(null);
    setRemoveAvatar(false);
  }

  const avatarChanged = pendingAvatar !== null || pendingPresetId !== null || removeAvatar;
  const profileTextChanged =
    displayName !== (profile.displayName ?? "") || description !== profile.description;
  const changed = avatarChanged || profileTextChanged;
  // A name the server would refuse is said so here, where it is typed, not as a failed save.
  const displayNameProblem = nameProblem(displayName);
  const canSave = changed && !saving && !displayNameProblem;

  const pendingPresetUrl = avatarPresets.find((preset) => preset.id === pendingPresetId)?.url;
  const headerAvatarSrc = editing
    ? removeAvatar
      ? undefined
      : (pendingAvatarPreview ?? pendingPresetUrl ?? profile.avatarUrl)
    : profile.avatarUrl;
  // The ringed picture: the one chosen now, else the saved one when it is a platform picture and
  // no upload or removal is pending.
  const selectedPresetId =
    pendingPresetId ??
    (pendingAvatar || removeAvatar
      ? null
      : (avatarPresets.find((preset) => preset.url === profile.avatarUrl)?.id ?? null));

  return (
    <div className="w-full pb-8">
      <section>
        <div aria-hidden="true" className="relative h-32 overflow-hidden bg-primary-solid sm:h-44">
          <img src={profileBanner} alt="" className="size-full object-cover" />
          {/* The picture above is the gradient's own first frame, so the page shows the finished
              banner at once; the live gradient draws over it from that same frame and then moves. */}
          {gradientReady && (
            <div className="absolute inset-0 isolate">
              <AnimatedGradient config={heroGradient} theme="dark" paused={reducedMotion} />
            </div>
          )}
        </div>
        <header className="flex min-w-0 items-start gap-4 px-4 sm:gap-6 sm:px-8">
          <div className="relative -mt-12 shrink-0">
            <IdentityAvatar
              size="2xl"
              className="size-24"
              name={profile.name}
              alt={profile.name}
              userId={profile.id}
              src={headerAvatarSrc}
            />
          </div>
          <div className="min-w-0 flex-1 pt-4">
            <h2 className="break-words text-display-xs font-semibold text-primary">
              {profile.name}
            </h2>
            {profile.email ? (
              <p className="break-words text-md text-tertiary">{profile.email}</p>
            ) : null}
          </div>
          {editing ? (
            <div className="mt-4 flex shrink-0 items-center gap-3">
              <Button type="button" color="secondary" isDisabled={saving} onPress={cancelEditing}>
                {m.settings_profile_cancel()}
              </Button>
              <Button type="button" isDisabled={!canSave} onPress={save}>
                {saving ? m.settings_profile_saving() : m.settings_profile_save()}
              </Button>
            </div>
          ) : (
            <Button type="button" className="mt-4 shrink-0" onPress={startEditing}>
              {m.settings_profile_edit()}
            </Button>
          )}
        </header>

        {saveSuccess && !editing && (
          <p role="status" className="mt-6 px-4 text-sm text-tertiary sm:px-8">
            <Check aria-hidden="true" className="mr-2 inline size-4 text-primary" />
            {m.settings_profile_save_success()}
          </p>
        )}

        <div className="mt-8 max-w-2xl px-4 sm:px-8">
          {editing ? (
            <div className="flex min-w-0 flex-col gap-6">
              {saveError && <SaveErrorMessage error={saveError} />}
              <Input
                label={m.settings_display_name()}
                hint={
                  displayNameProblem ? (
                    <span role="alert">{nameProblemText[displayNameProblem]()}</span>
                  ) : undefined
                }
                isRequired
                isInvalid={displayNameProblem !== undefined}
                value={displayName}
                isDisabled={saving}
                onChange={setDisplayName}
              />

              <div className="flex flex-col gap-1.5">
                <RadioGroup
                  value={selectedPresetId}
                  onChange={choosePreset}
                  isDisabled={saving}
                  orientation="horizontal"
                  className="flex flex-col gap-1.5"
                >
                  <Label>{m.welcome_avatar_label()}</Label>
                  {/* Fixed tracks: five a row at the name step's size, however wide the column. */}
                  <div className="grid grid-cols-[repeat(5,3.5rem)] gap-3">
                    {avatarPresets.map((preset) => (
                      <AvatarChoice
                        key={preset.id}
                        value={preset.id}
                        src={preset.url}
                        label={m.settings_avatar_preset_label({ number: preset.number })}
                        hideLabel
                      />
                    ))}
                  </div>
                </RadioGroup>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4">
                  <Button
                    type="button"
                    color="link-color"
                    size="sm"
                    isDisabled={saving}
                    onPress={() => avatarInputRef.current?.click()}
                  >
                    {m.settings_avatar_change()}
                  </Button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label={m.settings_avatar_change()}
                    disabled={saving}
                    className="sr-only"
                    onChange={upload}
                  />
                  <Button
                    type="button"
                    color="link-gray"
                    size="sm"
                    isDisabled={
                      saving ||
                      removeAvatar ||
                      !(profile.hasAvatar || pendingAvatar || pendingPresetId)
                    }
                    onPress={() => {
                      setPendingAvatar(null);
                      setPendingPresetId(null);
                      setRemoveAvatar(profile.hasAvatar);
                    }}
                  >
                    {m.settings_avatar_remove()}
                  </Button>
                </div>
                <p className="text-sm text-tertiary">{m.settings_avatar_help()}</p>
              </div>

              {profile.email || profile.phone ? (
                <dl className="flex min-w-0 flex-col gap-6">
                  <ContactValues profile={profile} />
                </dl>
              ) : null}

              <TextArea
                label={m.settings_user_description()}
                value={description}
                maxLength={280}
                rows={4}
                placeholder={m.settings_user_description_placeholder()}
                isDisabled={saving}
                hideRequiredIndicator
                hint={m.settings_description_remaining({ count: 280 - description.length })}
                onChange={setDescription}
              />
            </div>
          ) : (
            <dl className="flex min-w-0 flex-col gap-6">
              <ProfileValue label={m.settings_display_name()} value={profile.displayName || "-"} />
              <ContactValues profile={profile} />
              <ProfileValue
                label={m.settings_user_description()}
                value={profile.description || "-"}
              />
              <ProfileValue
                label={m.settings_joined_at()}
                value={hydrated ? formatCalendarDate(profile.joinedAt, timeZone, locale) : ""}
              />
              <div className="flex min-w-0 flex-col gap-2">
                <dt className="text-sm font-semibold text-primary">
                  {m.settings_created_agents()}
                </dt>
                <dd className="flex min-w-0 flex-wrap gap-2 text-sm text-primary">
                  <CreatedAgentFaces agents={createdAgents} />
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>
    </div>
  );
}

/** Each way a name is refused, worded as the first sign-in step words it. */
const nameProblemText: Record<PersonNameProblem, () => string> = {
  empty: () => m.welcome_error_empty(),
  too_long: () => m.welcome_error_too_long({ max: PERSON_NAME_MAX_LENGTH }),
  refused: () => m.welcome_error_refused(),
};

function nameProblem(name: string): PersonNameProblem | undefined {
  const checked = checkPersonName(name);
  return checked.ok ? undefined : checked.problem;
}

/** The person's own email and phone number, each only when there is one, with whether the identity
 * provider verified it, as Raft's Account shows the email. */
function ContactValues({ profile }: { profile: AccountProfile }) {
  return (
    <>
      {profile.email ? (
        <ContactValue
          label={m.settings_email()}
          value={profile.email}
          verified={profile.emailVerified}
        />
      ) : null}
      {profile.phone ? (
        <ContactValue
          label={m.settings_phone()}
          value={profile.phone}
          verified={profile.phoneVerified}
        />
      ) : null}
    </>
  );
}

function ContactValue({
  label,
  value,
  verified,
}: {
  label: string;
  value: string;
  /** Null while the provider has not said: the address alone, no tag. */
  verified: boolean | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm font-semibold text-primary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm text-primary">{value}</span>
        {verified === true ? (
          <BadgeWithIcon type="pill-color" size="sm" color="success" iconLeading={Check}>
            {m.settings_contact_verified()}
          </BadgeWithIcon>
        ) : verified === false ? (
          <Badge type="pill-color" size="sm" color="warning">
            {m.settings_contact_unverified()}
          </Badge>
        ) : null}
      </dd>
    </div>
  );
}

function ProfileValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm font-semibold text-primary">{label}</dt>
      <dd className="min-w-0 text-sm break-words whitespace-pre-wrap text-primary">{value}</dd>
    </div>
  );
}
