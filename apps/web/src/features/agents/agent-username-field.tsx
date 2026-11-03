import { useMemo, useState } from "react";
import { AtSign, RefreshCw05 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { m } from "#src/paraglide/messages";

import {
  availableAgentUsername,
  finishedAgentUsername,
  randomAgentUsername,
  typedAgentUsername,
} from "./agent-username";

/**
 * Where a person names an Agent — every such place uses this field (docs/design/component-decisions.md,
 * 「给 Agent 起名」; `test/agent-username-field.test.ts` keeps it so). Prefilled with a suggestion the
 * suggest button replaces, never one an Agent the viewer can see already has; reshaped as it is
 * typed so it never needs its rules spelled out; a name already taken says so before submit, which
 * the server checks again for the Agents the viewer cannot see. Mounted with the dialog's content,
 * so each opening suggests a fresh name. The form reads it as its `name` field.
 */
export function AgentUsernameField({
  label = m.agent_form_username(),
  defaultValue,
  note,
  autoFocus,
  isReadOnly,
}: {
  label?: string;
  defaultValue?: string;
  note?: string;
  autoFocus?: boolean;
  /** While a create runs: the name it sent stays the name shown. */
  isReadOnly?: boolean;
}) {
  const directory = useWorkspaceDirectory();
  const taken = useMemo(
    () => new Set((directory.data?.agents ?? []).map((agent) => agent.handle.toLowerCase())),
    [directory.data],
  );
  // What the person typed; until they do, the suggestion, which moves off a name the directory
  // (once read) has taken. A caller's own default is kept as given.
  const [typed, setTyped] = useState<string>();
  const [suggested, setSuggested] = useState(() => defaultValue ?? randomAgentUsername());
  const username = typed ?? (defaultValue ? suggested : availableAgentUsername(suggested, taken));
  // Typing cannot produce a malformed name, and Submit drops a trailing hyphen, so an empty field
  // is the one mistake left; it says how to fill the field rather than only that it is required.
  const [left, setLeft] = useState(false);
  const empty = left && username === "";
  const isTaken = !isReadOnly && taken.has(username.toLowerCase());
  return (
    <div className="relative min-w-0">
      <Input
        label={label}
        name="name"
        isRequired
        hideRequiredIndicator
        size="sm"
        icon={AtSign}
        autoFocus={autoFocus}
        isReadOnly={isReadOnly}
        value={username}
        onChange={(text) => setTyped(typedAgentUsername(text))}
        onBlur={() => {
          setLeft(true);
          setTyped((current) => current && finishedAgentUsername(current));
        }}
        validate={(value) =>
          !value
            ? m.agent_form_username_required()
            : !isReadOnly && taken.has(value.toLowerCase())
              ? m.agent_form_name_taken()
              : null
        }
        isInvalid={empty || isTaken}
        hint={empty ? m.agent_form_username_required() : isTaken ? m.agent_form_name_taken() : note}
        className="min-w-0"
      />
      <div className="absolute top-0 right-0 flex h-5 items-center">
        <ButtonUtility
          icon={RefreshCw05}
          size="xs"
          color="tertiary"
          tooltip={m.agent_form_username_suggest()}
          isDisabled={isReadOnly}
          onClick={() => {
            setTyped(undefined);
            setSuggested(randomAgentUsername(username, Math.random, taken));
          }}
        />
      </div>
    </div>
  );
}
