import { useEffect, useRef, useState } from "react";
import { useHydrated } from "@tanstack/react-router";
import { Camera01, Check } from "@untitledui/icons";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { AccountPasswordDialog } from "#src/features/profiles/account-password-dialog";
import { PersonAvatarDialog } from "#src/features/profiles/person-avatar-dialog";
import { CreatedAgentFaces } from "#src/features/agents/created-agent-faces";
import { Button } from "#src/components/base/buttons/button";
import { Badge, BadgeWithIcon } from "#src/components/base/badges/badges";
import { useAppForm } from "#src/components/ui/form";
import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  type PersonNameProblem,
} from "#src/features/profiles/person-name";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { formatCalendarDate } from "#src/lib/dates";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { SaveErrorMessage, saveErrorFrom, type SaveError } from "#src/components/save-error";
import { m } from "#src/paraglide/messages";
import type { SettingsContentProps } from "./settings-content";

export type AccountProfile = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean | null;
  phone: string | null;
  phoneVerified: boolean | null;
  description: string;
  avatarUrl: string | null;
  hasAvatar: boolean;
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
  bindArrival,
  onBindArrivalHandled,
}: SettingsContentProps) {
  const hydrated = useHydrated();
  const [editing, setEditing] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [arrival, setArrival] = useState(bindArrival);
  useEffect(() => {
    if (!bindArrival) return;
    setArrival(bindArrival);
    setPasswordDialogOpen(true);
    onBindArrivalHandled?.();
  }, [bindArrival, onBindArrivalHandled]);

  function startEditing() {
    setSaveSuccess(false);
    setEditing(true);
  }

  return (
    <div className="w-full pb-8">
      <section>
        <header className="flex min-w-0 items-center gap-4 px-page pt-8 sm:gap-6">
          <Button
            color="link-gray"
            size="sm"
            noTextPadding
            aria-label={m.settings_avatar_dialog_title()}
            className="relative shrink-0 rounded-full!"
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
            <span className="absolute right-0 bottom-0 grid size-7 place-items-center rounded-full bg-primary text-fg-secondary opacity-0 shadow-xs ring-1 ring-secondary transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
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
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="min-w-0 text-lg font-semibold wrap-anywhere text-primary">
                {profile.name}
              </h2>
              {!editing && (
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  className="shrink-0"
                  onPress={startEditing}
                >
                  {m.settings_profile_edit()}
                </Button>
              )}
            </div>
            {profile.email ? (
              <p className="text-md wrap-anywhere text-tertiary">{profile.email}</p>
            ) : null}
          </div>
        </header>

        {saveSuccess && !editing && (
          <p role="status" className="mt-6 px-page text-sm text-tertiary">
            <Check aria-hidden="true" className="mr-2 inline size-4 text-primary" />
            {m.settings_profile_save_success()}
          </p>
        )}

        <div className="mt-8 max-w-2xl px-page">
          {editing ? (
            <AccountProfileEditForm
              profile={profile}
              onProfileSave={onProfileSave}
              onSaved={() => {
                setSaveSuccess(true);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <dl className="flex min-w-0 flex-col gap-6">
              <ContactValues profile={profile} />
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-sm font-semibold text-primary">{m.settings_password()}</dt>
                <dd>
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    onPress={() => {
                      setArrival(undefined);
                      setPasswordDialogOpen(true);
                    }}
                  >
                    {m.settings_password_set()}
                  </Button>
                </dd>
              </div>
              <AccountPasswordDialog
                open={passwordDialogOpen}
                onOpenChange={setPasswordDialogOpen}
                profile={profile}
                arrival={arrival}
              />
              {profile.description ? (
                <ProfileValue label={m.settings_user_description()} value={profile.description} />
              ) : null}
              <ProfileValue
                label={m.settings_joined_at()}
                value={hydrated ? formatCalendarDate(profile.joinedAt, timeZone, locale) : ""}
              />
              {createdAgents.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-2">
                  <dt className="text-sm font-semibold text-primary">
                    {m.settings_created_agents()}
                  </dt>
                  <dd className="min-w-0 text-sm text-primary">
                    <CreatedAgentFaces agents={createdAgents} />
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </div>
      </section>
    </div>
  );
}

function AccountProfileEditForm({
  profile,
  onProfileSave,
  onSaved,
  onCancel,
}: {
  profile: AccountProfile;
  onProfileSave: SettingsContentProps["onProfileSave"];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const initialDisplayName = profile.displayName ?? "";
  const [saving, guard] = useSubmitGuard();
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  const form = useAppForm({
    defaultValues: {
      displayName: initialDisplayName,
      description: profile.description,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const changed =
        value.displayName !== initialDisplayName || value.description !== profile.description;
      if (!changed) return;
      await guard(async () => {
        setSaveError(null);
        try {
          await onProfileSave({ displayName: value.displayName, description: value.description });
          onSaved();
        } catch (cause) {
          setSaveError(saveErrorFrom(m.settings_profile_save_error(), cause));
        }
      });
    },
  });

  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        className="flex min-w-0 flex-col gap-6"
      >
        <form.AppField
          name="displayName"
          validators={{
            onChange: ({ value }) => nameProblemMessage(value),
            onSubmit: ({ value }) => nameProblemMessage(value),
          }}
        >
          {(field) => (
            <field.Input
              label={m.settings_display_name()}
              isRequired
              isDisabled={saving}
              onChange={() => setSaveError(null)}
            />
          )}
        </form.AppField>

        {profile.email || profile.phone ? (
          <dl className="flex min-w-0 flex-col gap-6">
            <ContactValues profile={profile} />
          </dl>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <form.AppField name="description">
            {(field) => (
              <field.TextArea
                label={m.settings_user_description()}
                maxLength={280}
                rows={4}
                placeholder={m.settings_user_description_placeholder()}
                isDisabled={saving}
                hideRequiredIndicator
                hint={m.settings_description_remaining({ count: 280 - field.state.value.length })}
                onChange={() => setSaveError(null)}
              />
            )}
          </form.AppField>
          {saveError && <SaveErrorMessage error={saveError} />}
        </div>

        <div className="flex justify-end gap-3">
          <Button type="button" size="sm" color="secondary" isDisabled={saving} onPress={onCancel}>
            {m.settings_profile_cancel()}
          </Button>
          <form.Subscribe
            selector={(state) => {
              const changed =
                state.values.displayName !== initialDisplayName ||
                state.values.description !== profile.description;
              return changed && !nameProblem(state.values.displayName);
            }}
          >
            {(canSave) => (
              <Button type="submit" size="sm" isLoading={saving} isDisabled={!canSave || saving}>
                {m.settings_profile_save()}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </form.AppForm>
  );
}

const nameProblemText: Record<PersonNameProblem, () => string> = {
  empty: () => m.welcome_error_empty(),
  too_long: () => m.welcome_error_too_long({ max: PERSON_NAME_MAX_LENGTH }),
  refused: () => m.welcome_error_refused(),
};

function nameProblem(name: string): PersonNameProblem | undefined {
  const checked = checkPersonName(name);
  return checked.ok ? undefined : checked.problem;
}

function nameProblemMessage(name: string): string | undefined {
  const problem = nameProblem(name);
  return problem ? nameProblemText[problem]() : undefined;
}

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
  verified: boolean | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm font-semibold text-primary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm wrap-anywhere text-primary">{value}</span>
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
