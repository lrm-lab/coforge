import { useId, type ReactNode } from "react";
import { Plus, XClose } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Label } from "#src/components/base/input/label";
import { SelectItem } from "#src/components/base/select/select-item";
import { visibleFieldError, withForm } from "#src/components/ui/form";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { APP_CATEGORIES } from "./app-category";
import { EMPTY_APP_DRAFT, refusedRedirectRows, type AppDraft } from "./app-draft";
import { APP_SCOPE_DESCRIPTIONS } from "./app-form";
import { APP_CATEGORY_LABELS } from "./app-list";
import { isAgentInboundScope } from "./app-agent-events";
import {
  APP_AGENT_INBOUND_SCOPES,
  APP_FIXED_SCOPES,
  appLoginScopes,
  APP_KEY_MAX_LENGTH,
  APP_WHEN_TO_USE_MAX_LENGTH,
  MAX_REDIRECT_URIS,
  type AppInputField,
} from "./app-registration";

export type FieldErrors = Partial<Record<AppInputField, string>>;

export type FieldsProps = {
  draft: AppDraft;
  change: <Field extends keyof AppDraft>(field: Field, value: AppDraft[Field]) => void;
  errors: FieldErrors;
  editing: boolean;
};

export function EditorSection({
  id,
  title,
  status,
  description,
  badge,
  children,
}: {
  id: string;
  title: string;
  status: string;
  description: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-4 gap-5 py-6">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-title`} className="text-md font-semibold text-primary">
            {title}
          </h3>
          <Badge size="sm" color="gray">
            {status}
          </Badge>
          {badge && (
            <Badge size="sm" color="brand">
              {badge}
            </Badge>
          )}
        </div>
        <p className="text-sm text-tertiary">{description}</p>
      </header>
      {children}
    </section>
  );
}

export const whenToUseLength = (draft: AppDraft) => [...draft.whenToUse.trim()].length;

export const ProfileFields = withForm({
  defaultValues: EMPTY_APP_DRAFT,
  props: {
    editing: false,
    logo: null as ReactNode,
  },
  render: function ProfileFieldsRender({ form, editing, logo }) {
    const counterId = useId();
    return (
      <>
        {logo}
        <form.AppField name="name">
          {(field) => (
            <field.Input
              label={m.apps_field_name()}
              placeholder={m.apps_field_name_placeholder()}
              isRequired
            />
          )}
        </form.AppField>
        <div className="grid gap-5 md:grid-cols-2">
          <form.AppField name="homepageUrl">
            {(field) => (
              <field.Input
                label={m.apps_field_homepage()}
                type="url"
                inputMode="url"
                placeholder="https://example.com/"
              />
            )}
          </form.AppField>
          <form.AppField name="category">
            {(field) => (
              <field.Select label={m.apps_field_category()}>
                {APP_CATEGORIES.map((category) => (
                  <SelectItem
                    key={category}
                    id={category}
                    label={APP_CATEGORY_LABELS[category]()}
                  />
                ))}
              </field.Select>
            )}
          </form.AppField>
        </div>
        <form.AppField name="description">
          {(field) => (
            <field.TextArea
              label={m.apps_field_description()}
              placeholder={m.apps_field_description_placeholder()}
              rows={3}
            />
          )}
        </form.AppField>
        <form.AppField name="key">
          {(field) => (
            <field.Input
              label={m.apps_field_key()}
              hint={editing ? m.apps_field_key_fixed_hint() : m.apps_field_key_hint()}
              isDisabled={editing}
              inputClassName="font-mono"
              autoComplete="off"
              spellCheck="false"
              maxLength={APP_KEY_MAX_LENGTH}
            />
          )}
        </form.AppField>
        <form.AppField
          name="whenToUse"
          validators={{
            onChange: ({ value }) =>
              [...value.trim()].length > APP_WHEN_TO_USE_MAX_LENGTH
                ? m.apps_error_when_to_use()
                : undefined,
          }}
        >
          {(field) => {
            const length = [...field.state.value.trim()].length;
            const tooLong = length > APP_WHEN_TO_USE_MAX_LENGTH;
            return (
              <div className="grid gap-1.5">
                <field.Input
                  label={m.apps_field_when_to_use()}
                  placeholder={m.apps_field_when_to_use_placeholder()}
                  hint={m.apps_field_when_to_use_hint()}
                  aria-describedby={counterId}
                />
                <p
                  id={counterId}
                  className={cn(
                    "text-right text-sm tabular-nums",
                    tooLong ? "text-error-primary" : "text-tertiary",
                  )}
                >
                  {m.apps_when_to_use_count({ count: length, max: APP_WHEN_TO_USE_MAX_LENGTH })}
                </p>
              </div>
            );
          }}
        </form.AppField>
      </>
    );
  },
});

export const LoginFields = withForm({
  defaultValues: EMPTY_APP_DRAFT,
  props: {
    agentEvents: false,
  },
  render: function LoginFieldsRender({ form, agentEvents }) {
    const redirectLabelId = useId();
    const redirectHintId = useId();
    const scopesLabelId = useId();
    return (
      <>
        <form.AppField name="redirectUris">
          {(field) => {
            const rows = field.state.value;
            const error = visibleFieldError(field.state.meta, field.form.state.submissionAttempts);
            const refusedRows = error ? refusedRedirectRows(rows) : new Set<number>();
            const updateRows = (next: string[]) => {
              if (field.state.meta.errorMap.onSubmit) {
                field.setMeta((prev) => ({
                  ...prev,
                  errorMap: { ...prev.errorMap, onSubmit: undefined },
                }));
              }
              field.handleChange(next);
            };
            return (
              <div
                data-field="redirectUris"
                role="group"
                aria-labelledby={redirectLabelId}
                className="grid gap-1.5"
              >
                <Label id={redirectLabelId} isInvalid={Boolean(error)}>
                  {m.apps_field_redirect_uris()}
                </Label>
                <ul className="grid gap-2">
                  {rows.map((uri, index) => (
                    <li key={index} className="flex items-center gap-1">
                      <Input
                        aria-label={m.apps_redirect_uri_label({ number: index + 1 })}
                        className="min-w-0 flex-1"
                        isInvalid={refusedRows.has(index)}
                        aria-describedby={refusedRows.has(index) ? redirectHintId : undefined}
                        type="url"
                        inputMode="url"
                        placeholder="https://example.com/login/callback"
                        value={uri}
                        onChange={(value) =>
                          updateRows(rows.map((row, at) => (at === index ? value : row)))
                        }
                      />
                      {rows.length > 1 && (
                        <ButtonUtility
                          icon={XClose}
                          size="sm"
                          color="tertiary"
                          tooltip={m.apps_remove_redirect_uri({ number: index + 1 })}
                          aria-label={m.apps_remove_redirect_uri({ number: index + 1 })}
                          onClick={() => updateRows(rows.filter((_, at) => at !== index))}
                        />
                      )}
                    </li>
                  ))}
                </ul>
                <p
                  id={redirectHintId}
                  role={error ? "alert" : undefined}
                  className={cn("text-sm", error ? "text-error-primary" : "text-tertiary")}
                >
                  {error ?? m.apps_field_redirect_uris_hint()}
                </p>
                {rows.length < MAX_REDIRECT_URIS && (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      color="link-gray"
                      iconLeading={Plus}
                      onPress={() => updateRows([...rows, ""])}
                    >
                      {m.apps_add_redirect_uri()}
                    </Button>
                  </div>
                )}
              </div>
            );
          }}
        </form.AppField>
        <form.AppField name="agentManifestUrl">
          {(field) => (
            <field.Input
              label={m.apps_field_agent_manifest()}
              hint={m.apps_field_agent_manifest_hint()}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck="false"
              placeholder="https://example.com/.well-known/coforge-agent-manifest.json"
            />
          )}
        </form.AppField>
        <form.AppField name="allowedScopes">
          {(field) => {
            const scopes = field.state.value;
            const error = visibleFieldError(field.state.meta, field.form.state.submissionAttempts);
            const email = appLoginScopes(scopes).includes("email");
            const updateScopes = (next: string[]) => {
              if (field.state.meta.errorMap.onSubmit) {
                field.setMeta((prev) => ({
                  ...prev,
                  errorMap: { ...prev.errorMap, onSubmit: undefined },
                }));
              }
              field.handleChange(next);
            };
            return (
              <div
                data-field="allowedScopes"
                role="group"
                aria-labelledby={scopesLabelId}
                className="grid gap-1.5"
              >
                <Label id={scopesLabelId}>{m.apps_field_scopes()}</Label>
                <div className="grid gap-3 rounded-xl border border-secondary p-4">
                  <p className="text-sm font-medium text-secondary">
                    {m.apps_scope_group_identity()}
                  </p>
                  {APP_FIXED_SCOPES.map((scope) => (
                    <Checkbox
                      key={scope}
                      isSelected
                      isDisabled
                      label={<span className="font-mono">{scope}</span>}
                      hint={`${APP_SCOPE_DESCRIPTIONS[scope]()} · ${m.apps_scope_fixed()}`}
                    />
                  ))}
                  <Checkbox
                    isSelected={email}
                    label={<span className="font-mono">email</span>}
                    hint={APP_SCOPE_DESCRIPTIONS.email()}
                    onChange={(selected) =>
                      updateScopes(
                        selected
                          ? [...scopes, "email"]
                          : scopes.filter((scope) => scope !== "email"),
                      )
                    }
                  />
                  {(agentEvents || scopes.some((scope) => isAgentInboundScope(scope))) && (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-secondary">
                          {m.apps_scope_group_agent_inbound()}
                        </p>
                        <Badge size="sm" color="brand">
                          {m.agent_app_events_experimental()}
                        </Badge>
                      </div>
                      <p className="text-sm text-tertiary">
                        {m.apps_scope_group_agent_inbound_hint()}
                      </p>
                      {APP_AGENT_INBOUND_SCOPES.map((scope) => (
                        <Checkbox
                          key={scope}
                          isSelected={scopes.includes(scope)}
                          label={<span className="font-mono">{scope}</span>}
                          hint={APP_SCOPE_DESCRIPTIONS[scope]()}
                          onChange={(selected) =>
                            updateScopes(
                              selected
                                ? [...scopes, scope]
                                : scopes.filter((held) => held !== scope),
                            )
                          }
                        />
                      ))}
                    </>
                  )}
                  {error && (
                    <p role="alert" className="text-sm text-error-primary">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            );
          }}
        </form.AppField>
      </>
    );
  },
});
