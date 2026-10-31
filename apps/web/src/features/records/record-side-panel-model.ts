import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";

/** What a side chat suggestion would change, as the text its preview shows. */
export function suggestionPreview(suggestion: WeeklyReportAssistantSuggestion): string {
  if (suggestion.type === "send-prompt") return "";
  if (suggestion.type === "template-create") {
    return [
      `Name: ${suggestion.name}`,
      `Schedule: weekday ${suggestion.sendWeekday} at ${suggestion.sendTime}`,
      ...suggestion.sections.map(
        (section) =>
          `## ${section.title}\n${section.children.map((child) => `- ${child}`).join("\n")}`,
      ),
    ].join("\n");
  }
  if (suggestion.type === "key-point-edit") return suggestion.markdown.trim();
  if (suggestion.type !== "body-edit") return "";
  const tabs = suggestion.content.tabs ?? {};
  return Object.entries(tabs)
    .map(([name, tab]) => `## ${name}\n${tab.markdown.trimEnd()}`)
    .join("\n\n");
}
