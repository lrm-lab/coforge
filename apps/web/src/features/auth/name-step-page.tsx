import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { RadioGroup } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Label } from "#src/components/base/input/label";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { AvatarChoice } from "#src/features/avatars/avatar-choice";
import { checkWorkspaceSlug, submitDisplayName } from "#src/features/auth/first-sign-in.functions";
import type { InviteState } from "#src/server/auth/first-sign-in.server";
import {
  afterSignInHref,
  isDefaultStartPage,
  localizedReturnHref,
} from "#src/features/auth/return-to";
import { avatarPresets } from "#src/features/profiles/avatar-presets";
import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  type PersonNameProblem,
} from "#src/features/profiles/person-name";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

type SlugProblem = "slug_invalid" | "slug_taken";
type Problem = PersonNameProblem | "save_failed" | SlugProblem;

const nameProblemText: Record<PersonNameProblem, () => string> = {
  empty: () => m.welcome_error_empty(),
  too_long: () => m.welcome_error_too_long({ max: PERSON_NAME_MAX_LENGTH }),
  refused: () => m.welcome_error_refused(),
};

const slugProblemText: Record<SlugProblem, () => string> = {
  slug_invalid: () => m.welcome_workspace_url_invalid(),
  slug_taken: () => m.welcome_workspace_url_taken(),
};

function isSlugProblem(problem: Problem): problem is SlugProblem {
  return problem === "slug_invalid" || problem === "slug_taken";
}

const SLUG_CHECK_DELAY_MS = 400;

function SlugPrefix({ className }: { className?: string }) {
  return (
    <span className={cn(className, "flex items-center justify-center font-mono text-md")}>/w/</span>
  );
}

function SlugAvailabilityWatcher({
  slug,
  enabled,
  onResult,
}: {
  slug: string;
  enabled: boolean;
  onResult: (checkedSlug: string, available: boolean) => void;
}) {
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!enabled || !isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)) return;
    let current = true;
    const timer = window.setTimeout(() => {
      checkWorkspaceSlug({ data: { slug } }).then(
        (result) => {
          if (current) onResultRef.current(slug, result.available);
        },
        () => {},
      );
    }, SLUG_CHECK_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [slug, enabled]);
  return null;
}

export function NameStepPage({
  prefill,
  slugPrefill,
  avatarPrefill,
  invite: initialInvite,
  returnTo,
}: {
  prefill: string;
  slugPrefill: string;
  avatarPrefill: string;
  invite: InviteState;
  returnTo: string | undefined;
}) {
  const submit = useServerFn(submitDisplayName);
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const slugEdited = useRef(false);
  const [invite, setInvite] = useState(initialInvite);
  const nameOnly = invite === "active";
  const [formError, setFormError] = useState("");
  const [submitting, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: {
      displayName: prefill,
      avatarPresetId: avatarPrefill,
      workspaceSlug: slugPrefill,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const slug = value.workspaceSlug.trim();
      await guard(async () => {
        setFormError("");
        let result: Awaited<ReturnType<typeof submit>> | undefined;
        try {
          result = await submit({
            data: nameOnly
              ? { displayName: value.displayName, avatarPresetId: value.avatarPresetId, returnTo }
              : {
                  displayName: value.displayName,
                  avatarPresetId: value.avatarPresetId,
                  workspaceSlug: slug,
                },
          });
        } catch {
          setFormError(m.welcome_error_save_failed());
          return;
        }
        if (!result) return STAY_PENDING;
        if (!result.ok) {
          if (result.problem === "invite_unavailable") {
            setInvite("unavailable");
            if (!slugEdited.current && slugPrefill === "") {
              form.setFieldValue("workspaceSlug", nameToWorkspaceSlug(value.displayName));
            }
            return;
          }
          reportServerProblem(result.problem);
          return;
        }
        const destination = nameOnly
          ? afterSignInHref(returnTo)
          : invite === "unavailable" || isDefaultStartPage(returnTo)
            ? localizedReturnHref(workspacePath(slug))
            : afterSignInHref(returnTo);
        try {
          await navigate({ href: destination });
        } catch {
          window.location.assign(destination);
        }
        return STAY_PENDING;
      });
    },
  });

  function clearSlugSubmitError() {
    form.setFieldMeta("workspaceSlug", (prev) =>
      prev.errorMap.onSubmit
        ? { ...prev, errorMap: { ...prev.errorMap, onSubmit: undefined } }
        : prev,
    );
  }

  function reportServerProblem(problem: Problem) {
    if (isSlugProblem(problem)) {
      setFieldServerError(form, "workspaceSlug", slugProblemText[problem](), formRef.current);
      return;
    }
    if (problem === "save_failed") {
      setFormError(m.welcome_error_save_failed());
      return;
    }
    setFieldServerError(form, "displayName", nameProblemText[problem](), formRef.current);
  }

  function handleSlugAvailability(checkedSlug: string, available: boolean) {
    if (form.getFieldValue("workspaceSlug").trim() !== checkedSlug) return;
    if (available) {
      clearSlugSubmitError();
    } else {
      setFieldServerError(form, "workspaceSlug", slugProblemText.slug_taken());
    }
  }

  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <CoForgeMark className="h-10" />
          <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
            {m.welcome_title()}
          </h1>
        </div>
        <form.AppForm>
          <form
            ref={formRef}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Subscribe selector={(state) => state.values.workspaceSlug.trim()}>
              {(slug) => (
                <SlugAvailabilityWatcher
                  slug={slug}
                  enabled={!nameOnly}
                  onResult={handleSlugAvailability}
                />
              )}
            </form.Subscribe>
            <div className="flex flex-col gap-6">
              {invite === "unavailable" ? (
                <p role="status" className="text-center text-md text-tertiary">
                  {m.welcome_invite_unavailable()}
                </p>
              ) : null}
              <form.AppField
                name="displayName"
                validators={{
                  onSubmit: ({ value }) => {
                    const checked = checkPersonName(value);
                    return checked.ok ? undefined : nameProblemText[checked.problem]();
                  },
                }}
              >
                {(field) => (
                  <field.Input
                    label={m.welcome_display_name_label()}
                    autoComplete="nickname"
                    autoFocus
                    onChange={(next) => {
                      if (!slugEdited.current && slugPrefill === "") {
                        form.setFieldValue("workspaceSlug", nameToWorkspaceSlug(next));
                        clearSlugSubmitError();
                      }
                      setFormError("");
                    }}
                  />
                )}
              </form.AppField>
              <form.AppField name="avatarPresetId">
                {(field) => (
                  <RadioGroup
                    value={field.state.value}
                    onChange={field.handleChange}
                    isDisabled={submitting}
                    orientation="horizontal"
                    className="flex flex-col gap-1.5"
                  >
                    <Label>{m.welcome_avatar_label()}</Label>
                    <div className="grid grid-cols-5 gap-3">
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
                )}
              </form.AppField>
              {nameOnly ? null : (
                <form.AppField
                  name="workspaceSlug"
                  validators={{
                    onSubmit: ({ value }) => {
                      const trimmed = value.trim();
                      return isValidWorkspaceSlug(trimmed) && !isReservedWorkspaceSlug(trimmed)
                        ? undefined
                        : slugProblemText.slug_invalid();
                    },
                  }}
                >
                  {(field) => (
                    <field.Input
                      label={m.welcome_workspace_url_label()}
                      autoComplete="off"
                      icon={SlugPrefix}
                      inputClassName="font-mono"
                      onChange={() => {
                        slugEdited.current = true;
                        setFormError("");
                      }}
                    />
                  )}
                </form.AppField>
              )}
              <form.Alert error={formError} />
            </div>
            <Button
              type="submit"
              size="lg"
              className="mt-6 w-full"
              isLoading={submitting}
              showTextWhileLoading
            >
              {m.welcome_continue()}
            </Button>
          </form>
        </form.AppForm>
      </div>
    </AuthSplitLayout>
  );
}
