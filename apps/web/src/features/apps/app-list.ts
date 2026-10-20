import { m } from "#src/paraglide/messages";
import type { AppCategory } from "./app-category";

/** How Settings → Applications names each category. */
export const APP_CATEGORY_LABELS: Record<AppCategory, () => string> = {
  "ai-automation": m.apps_category_ai_automation,
  communication: m.apps_category_communication,
  productivity: m.apps_category_productivity,
  "developer-tools": m.apps_category_developer_tools,
  "data-analytics": m.apps_category_data_analytics,
  "business-ops": m.apps_category_business_ops,
  infrastructure: m.apps_category_infrastructure,
  "content-creative": m.apps_category_content_creative,
  other: m.apps_category_other,
};

/** An app's stand-in logo: the first letters of its first two words, or the first two characters
 * of a one-word name, in capitals. Counted in code points, so no character is split. */
export function appMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? [...words[0]!].slice(0, 1).concat([...words[1]!].slice(0, 1))
      : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase();
}

type ListedApp = { key: string; name: string; description: string; category: string };

/** The apps a view shows: those of the chosen category (`all` for every one) whose name,
 * description or client ID holds the search, ignoring case; in the order given. */
export function filterApps<App extends ListedApp>(
  apps: readonly App[],
  { query, category }: { query: string; category: AppCategory | "all" },
): App[] {
  const needle = query.trim().toLowerCase();
  return apps.filter(
    (app) =>
      (category === "all" || app.category === category) &&
      (needle === "" ||
        [app.name, app.description, app.key].some((text) => text.toLowerCase().includes(needle))),
  );
}
