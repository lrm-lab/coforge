import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Toggle } from "#src/components/base/toggle/toggle";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { botProblem } from "./app-bot-copy";
import { setAppBotDeclared } from "./app-bots.functions";
import { EditorSection } from "./app-editor-fields";

/**
 * The Bot section of the app editor, where `app-bot` is on: whether the app declares a bot. The
 * switch acts at once, outside the form's Save, as the App notifications switch does. Declaring
 * creates no bot anywhere: each Workspace's owner or admin grants it on the installation. Turning
 * it off revokes every grant and disables the bots, which the hint says before it happens. While
 * registering (`appKey` absent) the switch waits for the app to exist.
 */
export function BotSection({
  id,
  appKey,
  declared,
  isDisabled,
  onChanged,
}: {
  id: string;
  appKey: string | undefined;
  /** The app's `enableBot` as the list now holds it. */
  declared: boolean;
  isDisabled: boolean;
  /** Reads the apps again once a change is saved; throws when it can't. */
  onChanged: () => Promise<void>;
}) {
  const declare = useServerFn(setAppBotDeclared);
  const [on, setOn] = useState(declared);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");

  async function toggle(key: string, next: boolean) {
    setPending(true);
    setProblem("");
    try {
      await declare({ data: { key, enabled: next } });
      setOn(next);
      await onChanged();
    } catch (cause) {
      setProblem(botProblem(cause, m.apps_bot_error_toggle));
    } finally {
      setPending(false);
    }
  }

  return (
    <EditorSection
      id={id}
      title={m.apps_bot_section()}
      status={on ? m.apps_bot_status_on() : m.apps_bot_status_off()}
      description={m.apps_bot_section_description()}
      badge={m.apps_bot_experimental()}
    >
      <div className="grid gap-4 [&>*]:min-w-0">
        {problem && <Alert color="error" title={problem} />}
        <div className="rounded-xl border border-secondary p-4">
          <Toggle
            className="w-full max-w-full"
            label={m.apps_bot_enable_title()}
            hint={
              appKey === undefined
                ? m.apps_bot_save_first()
                : on
                  ? m.apps_bot_enable_off_hint()
                  : m.apps_bot_enable_description()
            }
            isSelected={on}
            isDisabled={isDisabled || pending || appKey === undefined}
            onChange={(next) => appKey !== undefined && void toggle(appKey, next)}
          />
        </div>
      </div>
    </EditorSection>
  );
}
