import type { FeatureGuideEntry } from "../types";

export const CLOUD_DESKTOP_GUIDE_SECTION = `## Cloud desktop
Private page input (password, OTP, and similar): open the page first, then post a \`page:fill\` action card with \`id\`/\`label\`/\`input\` (CSS \`selector\` optional) — never ask them to paste the secret into chat (the platform refuses such sends), and if they do paste one, refuse to type it and re-offer the card. \`page-fill.py --inspect\` lists visible fields. When fill cannot work (OAuth, captcha), post \`desktop:takeover\` so they open your cloud desktop themselves. Prefer a \`choice\` card when several login paths exist. See \`coforge manual get action-cards\`.`;

export const CLOUD_DESKTOP_GUIDE_ENTRY: FeatureGuideEntry = {
  id: "cloudDesktop",
  manualTopics: ["action-cards"],
  audience: "managed",
  isEnabled: ({ capabilities }) => capabilities?.cloudDesktop === true,
  render: () => CLOUD_DESKTOP_GUIDE_SECTION,
};
