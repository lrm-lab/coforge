import { useId, type ReactNode } from "react";
import { Plus, XClose } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Label } from "#src/components/base/input/label";
import { Select } from "#src/components/base/select/select";
import { SelectItem } from "#src/components/base/select/select-item";
import { TextArea } from "#src/components/base/textarea/textarea";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { APP_CATEGORIES, type AppCategory } from "./app-category";
import { refusedRedirectRows, type AppDraft } from "./app-draft";
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

/** What the editor's sections are given: the draft, its change, and the problems to show. */
export type FieldsProps = {
  draft: AppDraft;
  change: <Field extends keyof AppDraft>(field: Field, value: AppDraft[Field]) => void;
  errors: FieldErrors;
  editing: boolean;
};

/** One section of the editor: its title, a status badge, what it is for, then its fields. */
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
  /** A second badge after the status, such as "Experimental". */
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

/** How many characters of when-to-use an Agent would be shown, counted as the rule counts them. */
export const whenToUseLength = (draft: AppDraft) => [...draft.whenToUse.trim()].length;

/** Profile: the app's logo (`AppLogoField`, given as `logo`), name, homepage, category,
 * description, client ID and the line Agents are shown. */
export function ProfileFields({
  draft,
  change,
  errors,
  editing,
  logo,
}: FieldsProps & { logo: ReactNode }) {
  const length = whenToUseLength(draft);
  const tooLong = length > APP_WHEN_TO_USE_MAX_LENGTH;
  const counterId = useId();
  return (
    <>
      {logo}
      <Input
        label={m.apps_field_name()}
        placeholder={m.apps_field_name_placeholder()}
        hint={errors.name}
        isRequired
        isInvalid={Boolean(errors.name)}
        value={draft.name}
        onChange={(value) => change("name", value)}
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Input
          label={m.apps_field_homepage()}
          hint={errors.homepageUrl}
          isInvalid={Boolean(errors.homepageUrl)}
          type="url"
          inputMode="url"
          placeholder="https://example.com/"
          value={draft.homepageUrl}
          onChange={(value) => change("homepageUrl", value)}
        />
        <Select
          label={m.apps_field_category()}
          hint={errors.category}
          value={draft.category}
          onChange={(key) => {
            const category = APP_CATEGORIES.find((candidate) => candidate === key);
            if (category) change("category", category satisfies AppCategory);
          }}
        >
          {APP_CATEGORIES.map((category) => (
            <SelectItem key={category} id={category} label={APP_CATEGORY_LABELS[category]()} />
          ))}
        </Select>
      </div>
      <TextArea
        label={m.apps_field_description()}
        placeholder={m.apps_field_description_placeholder()}
        hint={errors.description}
        isInvalid={Boolean(errors.description)}
        rows={3}
        value={draft.description}
        onChange={(value) => change("description", value)}
      />
      <Input
        label={m.apps_field_key()}
        hint={errors.key ?? (editing ? m.apps_field_key_fixed_hint() : m.apps_field_key_hint())}
        isDisabled={editing}
        isInvalid={Boolean(errors.key)}
        inputClassName="font-mono"
        autoComplete="off"
        spellCheck="false"
        maxLength={APP_KEY_MAX_LENGTH}
        value={draft.key}
        onChange={(value) => change("key", value)}
      />
      <div className="grid gap-1.5">
        <Input
          label={m.apps_field_when_to_use()}
          placeholder={m.apps_field_when_to_use_placeholder()}
          hint={
            tooLong || errors.whenToUse
              ? m.apps_error_when_to_use()
              : m.apps_field_when_to_use_hint()
          }
          isInvalid={tooLong || Boolean(errors.whenToUse)}
          aria-describedby={counterId}
          value={draft.whenToUse}
          onChange={(value) => change("whenToUse", value)}
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
    </>
  );
}

/** Login with CoForge: the exact URIs people return to, the Agent manifest URL (`manifest`: where
 * `app-agent-manifest` is on), and the scopes the app may ask for. */
export function LoginFields({
  draft,
  change,
  errors,
  manifest,
  agentEvents,
}: FieldsProps & { manifest: boolean; agentEvents: boolean }) {
  const redirectLabelId = useId();
  const redirectHintId = useId();
  const scopesLabelId = useId();
  const rows = draft.redirectUris;
  const refusedRows = errors.redirectUris ? refusedRedirectRows(rows) : new Set<number>();
  const email = appLoginScopes(draft.allowedScopes).includes("email");
  return (
    <>
      <div role="group" aria-labelledby={redirectLabelId} className="grid gap-1.5">
        <Label id={redirectLabelId} isInvalid={Boolean(errors.redirectUris)}>
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
                  change(
                    "redirectUris",
                    rows.map((row, at) => (at === index ? value : row)),
                  )
                }
              />
              {rows.length > 1 && (
                <ButtonUtility
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  tooltip={m.apps_remove_redirect_uri({ number: index + 1 })}
                  aria-label={m.apps_remove_redirect_uri({ number: index + 1 })}
                  onClick={() =>
                    change(
                      "redirectUris",
                      rows.filter((_, at) => at !== index),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
        {/* Plain text, not `HintText`: outside one field it would fill the Dialog's description
            slot (or, invalid, an error slot that is not there). */}
        <p
          id={redirectHintId}
          role={errors.redirectUris ? "alert" : undefined}
          className={cn("text-sm", errors.redirectUris ? "text-error-primary" : "text-tertiary")}
        >
          {errors.redirectUris ?? m.apps_field_redirect_uris_hint()}
        </p>
        {rows.length < MAX_REDIRECT_URIS && (
          <div>
            <Button
              type="button"
              size="sm"
              color="link-gray"
              iconLeading={Plus}
              onPress={() => change("redirectUris", [...rows, ""])}
            >
              {m.apps_add_redirect_uri()}
            </Button>
          </div>
        )}
      </div>
      {manifest && (
        <Input
          label={m.apps_field_agent_manifest()}
          hint={errors.agentManifestUrl ?? m.apps_field_agent_manifest_hint()}
          isInvalid={Boolean(errors.agentManifestUrl)}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck="false"
          placeholder="https://example.com/.well-known/coforge-agent-manifest.json"
          value={draft.agentManifestUrl}
          onChange={(value) => change("agentManifestUrl", value)}
        />
      )}
      <div role="group" aria-labelledby={scopesLabelId} className="grid gap-1.5">
        <Label id={scopesLabelId}>{m.apps_field_scopes()}</Label>
        <div className="grid gap-3 rounded-xl border border-secondary p-4">
          <p className="text-sm font-medium text-secondary">{m.apps_scope_group_identity()}</p>
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
              change(
                "allowedScopes",
                selected
                  ? [...draft.allowedScopes, "email"]
                  : draft.allowedScopes.filter((scope) => scope !== "email"),
              )
            }
          />
          {(agentEvents || draft.allowedScopes.some((scope) => isAgentInboundScope(scope))) && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-secondary">
                  {m.apps_scope_group_agent_inbound()}
                </p>
                <Badge size="sm" color="brand">
                  {m.agent_app_events_experimental()}
                </Badge>
              </div>
              <p className="text-sm text-tertiary">{m.apps_scope_group_agent_inbound_hint()}</p>
              {APP_AGENT_INBOUND_SCOPES.map((scope) => (
                <Checkbox
                  key={scope}
                  isSelected={draft.allowedScopes.includes(scope)}
                  label={<span className="font-mono">{scope}</span>}
                  hint={APP_SCOPE_DESCRIPTIONS[scope]()}
                  onChange={(selected) =>
                    change(
                      "allowedScopes",
                      selected
                        ? [...draft.allowedScopes, scope]
                        : draft.allowedScopes.filter((held) => held !== scope),
                    )
                  }
                />
              ))}
            </>
          )}
          {errors.allowedScopes && (
            <p role="alert" className="text-sm text-error-primary">
              {errors.allowedScopes}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
