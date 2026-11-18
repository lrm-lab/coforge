import { useMemo, useState } from "react";
import { AtSign, RefreshCw05 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { m } from "#src/paraglide/messages";

import {
  availableAgentUsername,
  finishedAgentUsername,
  randomAgentUsername,
  typedAgentUsername,
} from "./agent-username";

export function useAgentUsernameDraft(defaultValue?: string) {
  const [typed, setTyped] = useState<string>();
  const [suggested, setSuggested] = useState(() => defaultValue ?? randomAgentUsername());
  return { typed, setTyped, suggested, setSuggested };
}

export type AgentUsernameDraft = ReturnType<typeof useAgentUsernameDraft>;

export function AgentUsernameField({
  label = m.agent_form_username(),
  defaultValue,
  note,
  autoFocus,
  isReadOnly,
  draft,
}: {
  label?: string;
  defaultValue?: string;
  note?: string;
  autoFocus?: boolean;
  isReadOnly?: boolean;
  draft?: AgentUsernameDraft;
}) {
  const controlSize = useDialogControlSize();
  const directory = useWorkspaceDirectory();
  const taken = useMemo(
    () => new Set((directory.data?.agents ?? []).map((agent) => agent.handle.toLowerCase())),
    [directory.data],
  );
  const ownDraft = useAgentUsernameDraft(defaultValue);
  const { typed, setTyped, suggested, setSuggested } = draft ?? ownDraft;
  const username = typed ?? (defaultValue ? suggested : availableAgentUsername(suggested, taken));
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
        size={controlSize}
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
