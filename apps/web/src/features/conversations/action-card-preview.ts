import { m } from "#src/paraglide/messages";
import type { Locale } from "#src/paraglide/runtime";

/**
 * An action card as a list previews it: its kind and the few values its one line names, collected
 * from the stored payload (`previewCardOf`), and the Agent's note (`draftHint`) as written. The
 * browser writes the line in the viewer's language; the message body stays the English an Agent
 * reads.
 */
export type PreviewCard = {
  kind: string;
  params: Record<string, string | string[]>;
  hint?: string;
};

/** A card value that is a non-empty string, or undefined. */
export const cardText = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

/** A card value that is a non-empty list of strings, or undefined. */
export const cardTexts = (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

function summaryOf({ kind, params }: PreviewCard, locale?: Locale): string | undefined {
  const options = { locale };
  const joined = (list: string[] | undefined) =>
    list?.join(m.system_notice_list_separator({}, options));
  switch (kind) {
    case "channel:create":
    case "agent:create":
    case "app:register": {
      const name = cardText(params.name);
      if (!name) return undefined;
      if (kind === "channel:create") return m.action_card_preview_channel_create({ name }, options);
      if (kind === "agent:create") return m.action_card_preview_agent_create({ name }, options);
      return m.action_card_preview_app_register({ name }, options);
    }
    case "channel:add_member": {
      const channel = cardText(params.channel);
      const members = joined(cardTexts(params.members));
      return channel && members
        ? m.action_card_preview_add_member({ channel, members }, options)
        : undefined;
    }
    case "app:recover_owner": {
      const agent = cardText(params.agent);
      const app = cardText(params.app);
      return agent && app
        ? m.action_card_preview_app_recover_owner({ agent, app }, options)
        : undefined;
    }
    case "app:grant_agent": {
      const app = cardText(params.app);
      const key = cardText(params.key);
      return app && key ? m.action_card_preview_app_grant_agent({ app, key }, options) : undefined;
    }
    case "page:fill": {
      const labels = joined(cardTexts(params.labels));
      const prompt = cardText(params.prompt);
      if (!labels) return undefined;
      return prompt
        ? m.action_card_preview_page_fill_prompt({ prompt, labels }, options)
        : m.action_card_preview_page_fill({ labels }, options);
    }
    case "desktop:takeover": {
      const prompt = cardText(params.prompt);
      return prompt
        ? m.action_card_preview_desktop_takeover_prompt({ prompt }, options)
        : m.action_card_preview_desktop_takeover({}, options);
    }
    default:
      return undefined;
  }
}

/** A card's text in the viewer's language, the Agent's note on the next line as the stored body
 * has it; null for no card, or one that names nothing this can write (a kind or payload it does
 * not know), so the surface shows the stored body instead. */
export function actionCardPreviewText(
  card: PreviewCard | null | undefined,
  locale?: Locale,
): string | null {
  const summary = card ? summaryOf(card, locale) : undefined;
  if (!card || !summary) return null;
  return card.hint ? `${summary}\n${card.hint}` : summary;
}
