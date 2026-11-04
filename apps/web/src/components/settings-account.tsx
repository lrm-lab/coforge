import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";
import { useReducedMotion } from "motion/react";
import { Camera01, Check } from "@untitledui/icons";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import AnimatedGradient from "#src/components/spell/animated-gradient";
import { heroGradient, useWebGl2 } from "#src/features/landing/landing-brand-panel";
import { PersonAvatarDialog } from "#src/features/profiles/person-avatar-dialog";
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
}: SettingsContentProps) {
  const hydrated = useHydrated();
  const gradientReady = useWebGl2();
  const reducedMotion = useReducedMotion() ?? false;
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [description, setDescription] = useState(profile.description);
  const [saving, guard] = useSubmitGuard();
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDisplayName(profile.displayName ?? "");
      setDescription(profile.description);
    }
  }, [editing, profile.displayName, profile.description]);

  function startEditing() {
    setDisplayName(profile.displayName ?? "");
    setDescription(profile.description);
    setSaveError(null);
    setSaveSuccess(false);
    setEditing(true);
  }

  function cancelEditing() {
    setDisplayName(profile.displayName ?? "");
    setDescription(profile.description);
    setEditing(false);
  }

  async function save() {
    await guard(async () => {
      setSaveError(null);
      try {
        await onProfileSave({ displayName, description });
        setSaveSuccess(true);
        setEditing(false);
      } catch (cause) {
        setSaveError(saveErrorFrom(m.settings_profile_save_error(), cause));
      }
    });
  }

  const profileTextChanged =
    displayName !== (profile.displayName ?? "") || description !== profile.description;
  const changed = profileTextChanged;
  // A name the server would refuse is said so here, where it is typed, not as a failed save.
  const displayNameProblem = nameProblem(displayName);
  const canSave = changed && !saving && !displayNameProblem;

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
          {/* The picture is the way to change it, as on an Agent's profile: a camera shows on
              hover or focus. */}
          <Button
            color="link-gray"
            noTextPadding
            aria-label={m.settings_avatar_dialog_title()}
            className="relative -mt-12 shrink-0 rounded-full!"
            onPress={() => setAvatarDialogOpen(true)}
          >
            <ActorAvatar
              presence={false}
              size="2xl"
              className="size-24"
              name={profile.name}
              alt=""
              userId={profile.id}
              src={profile.avatarUrl}
            />
            <span className="absolute right-0 bottom-0 grid size-7 place-items-center rounded-full bg-primary text-fg-secondary opacity-0 shadow-xs ring-1 ring-secondary transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Camera01 className="size-4" />
            </span>
          </Button>
          <PersonAvatarDialog
            currentAvatarUrl={profile.avatarUrl}
            open={avatarDialogOpen}
            onOpenChange={setAvatarDialogOpen}
            onSave={onAvatarPresetChoose}
            onUpload={onAvatarUpload}
          />
          <div className="min-w-0 flex-1 pt-4">
            {/* Edit sits with the name it changes, not at the far edge of a wide window; while
                editing, Cancel and Save close the form below instead. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="min-w-0 break-words text-display-xs font-semibold text-primary">
                {profile.name}
              </h2>
              {!editing && (
                <Button type="button" className="shrink-0" onPress={startEditing}>
                  {m.settings_profile_edit()}
                </Button>
              )}
            </div>
            {profile.email ? (
              <p className="break-words text-md text-tertiary">{profile.email}</p>
            ) : null}
          </div>
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
              <div className="flex justify-end gap-3">
                <Button type="button" color="secondary" isDisabled={saving} onPress={cancelEditing}>
                  {m.settings_profile_cancel()}
                </Button>
                <Button type="button" isDisabled={!canSave} onPress={save}>
                  {saving ? m.settings_profile_saving() : m.settings_profile_save()}
                </Button>
              </div>
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
