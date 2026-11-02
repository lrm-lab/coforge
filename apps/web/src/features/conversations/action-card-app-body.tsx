import { m } from "#src/paraglide/messages";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

/** Details for an App grant / recover-owner / register card. */
export function ActionCardAppBody({
  view,
}: {
  view: Extract<ActionCardView, { kind: "app:grant_agent" | "app:recover_owner" | "app:register" }>;
}) {
  if (view.kind === "app:grant_agent") {
    return (
      <>
        <p>{m.app_card_request({ app: `${view.app.name} (${view.app.key})` })}</p>
        <p className="text-tertiary">{m.app_card_scopes({ scopes: view.scopes.join(", ") })}</p>
      </>
    );
  }
  if (view.kind === "app:recover_owner") {
    return (
      <>
        <p>
          {m.app_recover_card_request({
            agent: view.toAgent.name,
            app: `${view.app.name} (${view.app.key})`,
          })}
        </p>
        <p className="text-tertiary">{m.app_recover_card_note()}</p>
      </>
    );
  }
  return (
    <>
      <p>{view.app.name}</p>
      <p className="text-tertiary">
        {view.app.clientKey
          ? m.app_register_card_client_key({ key: view.app.clientKey })
          : m.app_register_card_client_key_auto()}
      </p>
      {view.app.redirectUrls.length > 0 && (
        <p className="text-tertiary break-all">
          {m.app_register_card_redirect({ urls: view.app.redirectUrls.join(", ") })}
        </p>
      )}
      {view.app.homepageUrl && (
        <p className="text-tertiary break-all">
          {m.app_register_card_homepage({ url: view.app.homepageUrl })}
        </p>
      )}
      {view.app.agentManifestUrl && (
        <p className="text-tertiary break-all">
          {m.app_register_card_manifest({ url: view.app.agentManifestUrl })}
        </p>
      )}
      {view.app.description && <p className="text-tertiary">{view.app.description}</p>}
      {view.app.whenToUse && (
        <p className="text-tertiary">
          {m.app_register_card_when_to_use({ text: view.app.whenToUse })}
        </p>
      )}
      <p className="text-tertiary">
        {m.app_register_card_category({ category: view.app.category })}
      </p>
      <p className="text-tertiary">
        {m.app_register_card_scopes({ scopes: view.app.scopes.join(", ") })}
      </p>
    </>
  );
}
