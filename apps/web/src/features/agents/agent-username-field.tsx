import { useState } from "react";
import { AtSign, Dice5 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";
import { finishedAgentUsername, randomAgentUsername, typedAgentUsername } from "./agent-username";

/**
 * The create form's username: prefilled with a suggestion the dice replaces, and reshaped as it is
 * typed so it never needs its rules spelled out. Mounted with the dialog's content, so each opening
 * suggests a fresh name.
 */
export function AgentUsernameField({
  defaultValue,
  note,
}: {
  defaultValue?: string;
  note?: string;
}) {
  const [username, setUsername] = useState(() => defaultValue ?? randomAgentUsername());
  // Typing cannot produce a malformed name, and Submit drops a trailing hyphen, so an empty field
  // is the one mistake left; it says how to fill the field rather than only that it is required.
  const [left, setLeft] = useState(false);
  const empty = left && username === "";
  return (
    <div className="relative min-w-0">
      <Input
        label={m.agent_form_username()}
        name="name"
        isRequired
        icon={AtSign}
        value={username}
        onChange={(text) => setUsername(typedAgentUsername(text))}
        onBlur={() => {
          setLeft(true);
          setUsername(finishedAgentUsername);
        }}
        validate={(value) => (value ? null : m.agent_form_username_required())}
        isInvalid={empty}
        hint={empty ? m.agent_form_username_required() : note}
        className="min-w-0"
      />
      <div className="absolute top-0 right-0 flex h-5 items-center">
        <ButtonUtility
          icon={Dice5}
          size="xs"
          color="tertiary"
          tooltip={m.agent_form_username_suggest()}
          onClick={() => setUsername((current) => randomAgentUsername(current))}
        />
      </div>
    </div>
  );
}
