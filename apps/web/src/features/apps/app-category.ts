/** What an app is for, as the app list files it. Its own small module: the Settings route's search
 * validation reads it, and lands in every page's static chunk. */
export const APP_CATEGORIES = [
  "ai-automation",
  "communication",
  "productivity",
  "developer-tools",
  "data-analytics",
  "business-ops",
  "infrastructure",
  "content-creative",
  "other",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];
