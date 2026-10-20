import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useReducedMotion } from "motion/react";
import { XClose } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Alert } from "#src/components/ui/alert";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DangerZoneRows } from "./app-editor-danger";
import {
  EditorSection,
  LoginFields,
  ProfileFields,
  whenToUseLength,
  type FieldErrors,
} from "./app-editor-fields";
import { EMPTY_APP_DRAFT, draftOf, inputOf, type AppDraft } from "./app-draft";
import { APP_FIELD_PROBLEMS, appFormProblem } from "./app-form";
import { AppLogo } from "./app-logo";
import {
  APP_WHEN_TO_USE_MAX_LENGTH,
  refusedAppFields,
  type AppRegistrationInput,
} from "./app-registration";
import { AppSecretPanel, type IssuedSecret } from "./app-secret-panel";
import type { AppSummary } from "./apps.functions";

/**
 * Registers an app (`app` absent) or edits one, in one wide form: a section nav beside Profile,
 * Login with CoForge and, when editing, the Danger zone. One Save sends the form; regenerating the
 * secret and deleting act at once. A click outside never closes it; Escape and the close button
 * do, except while a save runs.
 */
export function AppEditor({
  open,
  app,
  issued,
  onClose,
  onSubmit,
  onRegenerate,
  onDelete,
}: {
  open: boolean;
  app?: AppSummary;
  /** A secret regenerated for this app, shown in the editor's notice strip. */
  issued: IssuedSecret | null;
  onClose: () => void;
  /** Sends the input: the whole registration, or the change without the key. Throws when refused. */
  onSubmit: (input: AppRegistrationInput) => Promise<void>;
  onRegenerate: (app: AppSummary) => Promise<void>;
  onDelete: (app: AppSummary) => Promise<void>;
}) {
  const [saving, guard] = useSubmitGuard();
  return (
    <ModalOverlay
      isOpen={open}
      isKeyboardDismissDisabled={saving}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-4xl">
        <Dialog className="flex max-h-[inherit] flex-col overflow-hidden text-left">
          {({ close }) => (
            // Each opening starts from the app as it is now, or from an empty form.
            <AppEditorForm
              key={app?.key ?? "new"}
              app={app}
              issued={issued}
              saving={saving}
              guard={guard}
              onClose={close}
              onSubmit={onSubmit}
              onRegenerate={onRegenerate}
              onDelete={onDelete}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

type Section = { id: string; title: string };

function AppEditorForm({
  app,
  issued,
  saving,
  guard,
  onClose,
  onSubmit,
  onRegenerate,
  onDelete,
}: {
  app?: AppSummary;
  issued: IssuedSecret | null;
  saving: boolean;
  guard: ReturnType<typeof useSubmitGuard>[1];
  onClose: () => void;
  onSubmit: (input: AppRegistrationInput) => Promise<void>;
  onRegenerate: (app: AppSummary) => Promise<void>;
  onDelete: (app: AppSummary) => Promise<void>;
}) {
  const editing = app !== undefined;
  const [draft, setDraft] = useState<AppDraft>(() => (app ? draftOf(app) : EMPTY_APP_DRAFT));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const ids = {
    profile: `${idPrefix}profile`,
    login: `${idPrefix}login`,
    danger: `${idPrefix}danger`,
  };
  const sections: Section[] = [
    { id: ids.profile, title: m.apps_section_profile() },
    { id: ids.login, title: m.apps_section_login() },
    ...(editing ? [{ id: ids.danger, title: m.apps_section_danger() }] : []),
  ];
  const [active, setActive] = useActiveSection(scroller, sections);
  const reducedMotion = useReducedMotion() ?? false;
  const tooLong = whenToUseLength(draft) > APP_WHEN_TO_USE_MAX_LENGTH;

  function change<Field extends keyof AppDraft>(field: Field, value: AppDraft[Field]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    const input = inputOf(draft);
    // A change never carries the key (it is the client ID), and a blank one asks for a made key.
    const { key, ...rest } = input;
    const refused = refusedAppFields(editing || key === "" ? rest : input);
    if (refused.length > 0) {
      setErrors(Object.fromEntries(refused.map((field) => [field, APP_FIELD_PROBLEMS[field]()])));
      return;
    }
    void guard(async () => {
      try {
        await onSubmit(input);
      } catch (cause) {
        const problem = appFormProblem(
          cause,
          editing ? m.apps_error_update : m.apps_error_register,
        );
        if (problem.field) setErrors({ [problem.field]: problem.message });
        else setFormError(problem.message);
      }
    });
  }

  const profileComplete = [draft.name, draft.description, draft.homepageUrl].every(
    (value) => value.trim() !== "",
  );
  const hasRedirect = draft.redirectUris.some((uri) => uri.trim() !== "");
  const fields = { draft, change, errors, editing };

  return (
    // The rules below are the registry's own, shown inline beside each field; the browser's bubbles
    // would show only the first and in its own words.
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-secondary px-6 py-4">
        <AppLogo name={draft.name || "?"} size="sm" />
        <Heading
          slot="title"
          className="min-w-0 flex-1 truncate text-lg font-semibold text-primary"
        >
          {editing ? m.apps_edit_title({ name: app.name }) : m.apps_register_title()}
        </Heading>
        <ButtonUtility
          type="button"
          aria-label={m.apps_editor_close()}
          icon={XClose}
          size="sm"
          color="tertiary"
          isDisabled={saving}
          onClick={onClose}
        />
      </div>
      {(formError || issued) && (
        <div className="grid shrink-0 gap-3 border-b border-secondary px-6 py-4">
          {formError && <Alert color="error" title={formError} />}
          {issued && <AppSecretPanel issued={issued} />}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={m.apps_editor_sections()}
          className="hidden w-44 shrink-0 border-r border-secondary p-3 md:block"
        >
          <ul className="grid gap-1">
            {sections.map((section) => (
              <li key={section.id}>
                <Button
                  type="button"
                  color="tertiary"
                  size="sm"
                  aria-current={active === section.id ? "true" : undefined}
                  className={cn(
                    "w-full justify-start",
                    active === section.id && "bg-active text-brand-secondary",
                  )}
                  onPress={() => {
                    setActive(section.id);
                    document
                      .getElementById(section.id)
                      ?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                  }}
                >
                  {section.title}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <div
          ref={scroller}
          className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto px-6"
        >
          <EditorSection
            id={ids.profile}
            title={m.apps_section_profile()}
            status={profileComplete ? m.apps_status_complete() : m.apps_status_needs_details()}
            description={m.apps_section_profile_description()}
          >
            <ProfileFields {...fields} />
          </EditorSection>
          <EditorSection
            id={ids.login}
            title={m.apps_section_login()}
            status={
              !hasRedirect
                ? m.apps_status_not_configured()
                : editing
                  ? m.apps_status_ready()
                  : m.apps_status_ready_to_save()
            }
            description={m.apps_section_login_description()}
          >
            <LoginFields {...fields} />
          </EditorSection>
          {editing && (
            <EditorSection
              id={ids.danger}
              title={m.apps_section_danger()}
              status={m.apps_status_restricted()}
              description={m.apps_section_danger_description()}
            >
              <DangerZoneRows
                app={app}
                isDisabled={saving}
                onRegenerate={() => onRegenerate(app)}
                onDelete={() => onDelete(app)}
              />
            </EditorSection>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
        <Button type="button" size="sm" color="secondary" isDisabled={saving} onPress={onClose}>
          {m.controls_cancel()}
        </Button>
        <Button
          type="submit"
          size="sm"
          color="primary"
          isDisabled={saving || tooLong}
          isLoading={saving}
          showTextWhileLoading
        >
          {saving ? m.apps_saving() : editing ? m.apps_save() : m.apps_register_submit()}
        </Button>
      </div>
    </form>
  );
}

/** The section the form is scrolled to: the first one showing in the top of the scroll area, or
 * the last once the area is scrolled to its end (a short last section never reaches the top). */
function useActiveSection(
  scroller: React.RefObject<HTMLDivElement | null>,
  sections: Section[],
): [string, (id: string) => void] {
  const ids = sections.map((section) => section.id).join(" ");
  const [active, setActive] = useState(sections[0]!.id);
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const order = ids.split(" ");
    const atEnd = () => root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
    const choose = () => {
      const first = order.find((id) => visible.has(id));
      if (atEnd() && root.scrollTop > 0) setActive(order[order.length - 1]!);
      else if (first) setActive(first);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        choose();
      },
      // A section counts once it reaches the top two-fifths of the scroll area.
      { root, rootMargin: "0px 0px -60% 0px" },
    );
    for (const id of order) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    root.addEventListener("scroll", choose, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", choose);
    };
  }, [scroller, ids]);
  return [active, setActive];
}
