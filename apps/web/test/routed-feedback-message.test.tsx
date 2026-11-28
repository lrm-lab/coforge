import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageShareCard } from "../src/features/conversations/message-share-card";
import { groupsWithPrevious, type MessageView } from "../src/features/conversations/message-view";
import { RoutedFeedbackBody } from "../src/features/conversations/routed-feedback-body";
import {
  parseRoutedFeedbackMessage,
  routedFeedbackPreviewText,
} from "../src/features/conversations/routed-feedback-message";
import { formatFeedbackChannelMessage } from "../src/server/feedback/feedback-channel-routing.server";
import { setLocale } from "../src/paraglide/runtime";

function baseMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "msg-1",
    sequence: 1,
    senderKind: "system",
    senderMemberId: null,
    senderName: "System",
    body: "",
    createdAt: "2026-11-28T13:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

describe("parseRoutedFeedbackMessage", () => {
  test("parses valid formatFeedbackChannelMessage output for bug, idea, and other", () => {
    for (const [category, body] of [
      ["bug", "Line 1\nLine 2"],
      ["idea", "Support dark mode toggle"],
      ["other", "Question about quota"],
    ] as const) {
      const formatted = formatFeedbackChannelMessage({
        feedbackId: "fb-123",
        category,
        body,
        authorName: "Frank",
        authorEmail: "me.frankan@gmail.com",
        workspaceName: "LRM Lab",
        pagePath: "/en/w/lrm-lab/channel/1",
        clientInfo: "Web · macOS",
        attachments: [],
        createdAt: "2026-11-28T13:00:00.000Z",
      });
      const parsed = parseRoutedFeedbackMessage({ senderKind: "system", body: formatted });
      expect(parsed).not.toBeNull();
      expect(parsed?.category).toBe(category);
      expect(parsed?.quoteMarkdown).toBe(body);
      expect(parsed?.authorName).toBe("Frank");
      expect(parsed?.authorEmailRaw).toBe("me.frankan[at]gmail.com");
      expect(parsed?.authorEmailDisplay).toBe("me.frankan@gmail.com");
      expect(parsed?.workspaceName).toBe("LRM Lab");
      expect(parsed?.pagePath).toBe("/en/w/lrm-lab/channel/1");
      expect(parsed?.clientInfo).toBe("Web · macOS");
      expect(parsed?.feedbackId).toBe("fb-123");
    }
  });

  test("handles missing optional metadata fields", () => {
    const formatted = formatFeedbackChannelMessage({
      feedbackId: "fb-min",
      category: "other",
      body: "Hello",
      authorName: null,
      authorEmail: null,
      workspaceName: null,
      pagePath: null,
      clientInfo: null,
      attachments: [],
      createdAt: "2026-11-28T13:00:00.000Z",
    });
    const parsed = parseRoutedFeedbackMessage({ senderKind: "system", body: formatted });
    expect(parsed).not.toBeNull();
    expect(parsed?.authorName).toBe("Unknown user");
    expect(parsed?.authorEmailRaw).toBeNull();
    expect(parsed?.authorEmailDisplay).toBeNull();
    expect(parsed?.workspaceName).toBeNull();
    expect(parsed?.pagePath).toBeNull();
    expect(parsed?.clientInfo).toBeNull();
  });

  test("rejects spoofed user or agent messages even with matching markdown", () => {
    const formatted = formatFeedbackChannelMessage({
      feedbackId: "fb-spoof",
      category: "bug",
      body: "Spoof attempt",
      authorName: "Evil",
      authorEmail: "evil@attacker.com",
      workspaceName: null,
      pagePath: null,
      clientInfo: null,
      attachments: [],
      createdAt: "2026-11-28T13:00:00.000Z",
    });
    expect(parseRoutedFeedbackMessage({ senderKind: "user", body: formatted })).toBeNull();
    expect(parseRoutedFeedbackMessage({ senderKind: "agent", body: formatted })).toBeNull();
  });

  test("preserves untrusted escaping in quoteMarkdown, authorName, and malformed emails", () => {
    const formatted = formatFeedbackChannelMessage({
      feedbackId: "fb-sec",
      category: "idea",
      body: "Check @coordinator #general <@agent:0194b4a8-1a2b-7c3d-8e4f-5a6b7c8d9e0f> and alice@example.com",
      authorName: "Alice @admin <script>",
      authorEmail: "bad@@example.com",
      workspaceName: "Acme #1",
      pagePath: "/w/acme",
      clientInfo: "Web",
      attachments: [],
      createdAt: "2026-11-28T13:00:00.000Z",
    });
    const parsed = parseRoutedFeedbackMessage({ senderKind: "system", body: formatted });
    expect(parsed).not.toBeNull();
    expect(parsed?.quoteMarkdown).toContain("[at]coordinator [#]general");
    expect(parsed?.quoteMarkdown).toContain("alice[at]example.com");
    expect(parsed?.authorName).toBe("Alice [at]admin <script> (bad[at][at]example.com)");
    expect(parsed?.authorEmailRaw).toBeNull();
    expect(parsed?.authorEmailDisplay).toBeNull();
    expect(parsed?.workspaceName).toBe("Acme [#]1");
  });
});

describe("RoutedFeedbackBody and MessageShareCard email visibility", () => {
  const formatted = formatFeedbackChannelMessage({
    feedbackId: "fb-render",
    category: "bug",
    body: "Mention probe @here #general and user@domain.com <img src=x onerror=alert(1)>",
    authorName: "Frank",
    authorEmail: "me.frankan@gmail.com",
    workspaceName: "Dev Workspace",
    pagePath: "/en/w/dev/settings",
    clientInfo: "Web · macOS",
    attachments: [],
    createdAt: "2026-11-28T13:00:00.000Z",
  });
  const parsed = parseRoutedFeedbackMessage({ senderKind: "system", body: formatted })!;

  test("workspace view shows plain email without mailto or mention links and keeps body escaped", () => {
    const html = renderToStaticMarkup(<RoutedFeedbackBody feedback={parsed} showEmailPlain />);
    expect(html).toContain("me.frankan@gmail.com");
    expect(html).not.toContain("me.frankan[at]gmail.com");
    expect(html).not.toContain("mailto:");
    expect(html).toContain("[at]here [#]general");
    expect(html).toContain("user[at]domain.com");
    expect(html).not.toContain("<img");
  });

  test("share card view replaces System label with CoForge Feedback while keeping email obfuscated", async () => {
    setLocale("en", { reload: false });
    const queryClient = new QueryClient();
    const msg = baseMessage({ body: formatted });
    const rootRoute = createRootRoute({
      component: () => <MessageShareCard messages={[msg]} width={720} />,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(html).toContain("CoForge Feedback");
    expect(html).toContain("Bug report");
    expect(html).not.toContain(">System<");
    expect(html).toContain("me.frankan[at]gmail.com");
    expect(html).not.toContain("me.frankan@gmail.com");
  });

  test("groupsWithPrevious never merges consecutive system messages", () => {
    const first = baseMessage({ id: "m1", body: formatted, createdAt: "2026-11-28T13:00:00.000Z" });
    const second = baseMessage({
      id: "m2",
      body: formatted,
      createdAt: "2026-11-28T13:00:10.000Z",
    });
    expect(groupsWithPrevious(second, first, false, false).grouped).toBe(false);
  });

  test("routedFeedbackPreviewText formats clean single-line summary", () => {
    expect(routedFeedbackPreviewText(parsed, "Bug report")).toContain(
      "Bug report: Mention probe [at]here [#]general",
    );
  });
});
