import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { botProblem } from "./app-bot-copy";
import { grantAppBot, revokeAppBot } from "./app-bots.functions";
import type { AppBotSummary } from "./app-bot";

/** The bot of an installed app in its detail: nothing unless `app-bot` is on for the Workspace
 * (`declares.bot`) and the app declares a bot (the server sends `bot` only then). */
export function AppBotInstallation({
  declares,
  app,
  canManage,
  onChanged,
}: {
  declares: { bot: boolean };
  app: { key: string; bot?: AppBotSummary };
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  if (!declares.bot || !app.bot) return null;
  return <BotGrant appKey={app.key} bot={app.bot} canManage={canManage} onChanged={onChanged} />;
}

/**
 * This Workspace's bot of an installed app, in the app's detail, where `app-bot` is on and the app
 * declares one. Everyone sees whether the bot is enabled and the line its app published; an owner
 * or admin (`canManage`) enables it ("Enable bot": the bot is made here, named for the app) and
 * disables it ("Disable bot": its key ends). The app's Login and notifications approvals do not
 * enable it. `onChanged` reads the apps again; a refusal shows inline.
 */
function BotGrant({
  appKey,
  bot,
  canManage,
  onChanged,
}: {
  appKey: string;
  bot: AppBotSummary;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const grant = useServerFn(grantAppBot);
  const revoke = useServerFn(revokeAppBot);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");

  async function change(next: boolean) {
    setPending(true);
    setProblem("");
    try {
      await (next ? grant : revoke)({ data: { key: appKey } });
      await onChanged();
    } catch (cause) {
      setProblem(
        botProblem(cause, next ? m.apps_bot_error_grant : m.apps_bot_error_revoke, appKey),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-primary">{m.apps_bot_installation_title()}</h3>
        {bot.granted && (
          <Badge size="sm" color="success">
            {m.apps_bot_badge_enabled()}
          </Badge>
        )}
      </div>
      <p className="text-sm text-tertiary">{m.apps_bot_installation_description()}</p>
      {bot.granted && bot.statusText && (
        <p className="text-sm wrap-anywhere text-secondary">
          {m.apps_bot_status_line({ text: bot.statusText })}
        </p>
      )}
      {problem && <Alert color="error" title={problem} />}
      {canManage ? (
        <div>
          <Button
            size="sm"
            color={bot.granted ? "secondary-destructive" : "secondary"}
            isDisabled={pending}
            isLoading={pending}
            showTextWhileLoading
            onPress={() => void change(!bot.granted)}
          >
            {bot.granted ? m.apps_bot_revoke() : m.apps_bot_grant()}
          </Button>
        </div>
      ) : (
        !bot.granted && <p className="text-sm text-tertiary">{m.apps_bot_member_note()}</p>
      )}
    </section>
  );
}
