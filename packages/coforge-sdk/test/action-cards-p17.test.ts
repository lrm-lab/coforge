import { describe, expect, test } from "bun:test";
import {
  CHOICE_ANYONE_TARGET,
  CHOICE_DEADLINE_MAX_MINUTES,
  actionCardActionSchema,
  agentApiRoutes,
  createAgentApiClient,
  deadlineMisuse,
  decodeAgentActionWithdrawResponse,
  decodeAgentInboxDismissResponse,
  decodeAgentInboxReadResponse,
  validateActionCardAction,
} from "../src/agent/index";

describe("P1-7 richer choice and questions action card schemas", () => {
  test("accepts 1-button confirm on choice and questions cards while rejecting 0 options", () => {
    const confirmChoice = actionCardActionSchema.safeParse({
      type: "choice",
      prompt: "Proceed with production rollout?",
      to: "@alice",
      options: [{ id: "confirm", label: "Proceed", recommended: true }],
    });
    expect(confirmChoice.success).toBe(true);
    if (confirmChoice.success) {
      expect(validateActionCardAction(confirmChoice.data)).toBeNull();
    }

    const emptyChoice = actionCardActionSchema.safeParse({
      type: "choice",
      prompt: "Empty?",
      to: "@alice",
      options: [],
    });
    expect(emptyChoice.success).toBe(false);

    const confirmQuestion = actionCardActionSchema.safeParse({
      type: "questions",
      to: "@alice",
      questions: [
        {
          id: "ack",
          prompt: "Acknowledge maintenance window?",
          options: [{ id: "yes", label: "Acknowledge" }],
        },
      ],
    });
    expect(confirmQuestion.success).toBe(true);
    if (confirmQuestion.success) {
      expect(validateActionCardAction(confirmQuestion.data)).toBeNull();
    }
  });

  test("accepts to: 'anyone' channel addressee on choice and questions cards", () => {
    expect(CHOICE_ANYONE_TARGET).toBe("anyone");

    const anyoneChoice = actionCardActionSchema.safeParse({
      type: "choice",
      prompt: "Who can review PR #42?",
      to: "anyone",
      options: [{ id: "claim", label: "I will review it" }],
      expiresInMinutes: 60,
    });
    expect(anyoneChoice.success).toBe(true);

    const anyoneQuestions = actionCardActionSchema.safeParse({
      type: "questions",
      to: "anyone",
      expiresInMinutes: CHOICE_DEADLINE_MAX_MINUTES,
      questions: [
        {
          id: "env",
          prompt: "Which staging slot is free?",
          options: [
            { id: "blue", label: "Blue" },
            { id: "green", label: "Green" },
          ],
        },
      ],
    });
    expect(anyoneQuestions.success).toBe(true);
  });

  test("supports standalone kind: 'text' free-text questions and rejects invalid combinations", () => {
    const textQuestion = actionCardActionSchema.safeParse({
      type: "questions",
      prompt: "Release checklist",
      to: "anyone",
      expiresInMinutes: 120,
      questions: [
        {
          id: "notes",
          kind: "text",
          prompt: "Paste any rollback notes or incident links",
          placeholder: "Optional notes...",
        },
        {
          id: "ready",
          prompt: "Ready to ship?",
          options: [{ id: "ship", label: "Ship now" }],
        },
      ],
    });
    expect(textQuestion.success).toBe(true);
    if (textQuestion.success) {
      expect(validateActionCardAction(textQuestion.data)).toBeNull();
    }

    const textWithOptions = actionCardActionSchema.safeParse({
      type: "questions",
      to: "@alice",
      questions: [
        {
          id: "bad",
          kind: "text",
          prompt: "Free text",
          options: [{ id: "a", label: "A" }],
        },
      ],
    });
    if (textWithOptions.success) {
      expect(validateActionCardAction(textWithOptions.data)).toContain("cannot include options");
    } else {
      expect(textWithOptions.success).toBe(false);
    }

    expect(
      deadlineMisuse({
        type: "channel:create",
        name: "ops",
        visibility: "public",
        expiresInMinutes: 30,
      }),
    ).toContain("expiresInMinutes");
  });
});

describe("P1-7 inbox read/dismiss and action withdraw SDK contracts", () => {
  test("decodes inbox read, inbox dismiss, and action withdraw responses and routes via createAgentApiClient", async () => {
    const calls: Array<{ route: unknown; input?: unknown }> = [];
    const client = createAgentApiClient({
      async request(route, input) {
        calls.push({ route, input });
        const path = typeof route === "string" ? route : (route as { path: string }).path;
        if (path.includes("/inbox/read")) {
          return {
            ok: true,
            status: 200,
            data: {
              ok: true,
              kind: "conversation",
              target: "#general",
              items: [
                {
                  kind: "message",
                  id: "0196ed00-0000-7000-8000-000000000001",
                  seq: 11,
                  sender: "@alice",
                  createdAt: "2026-11-17T12:00:00.000Z",
                  body: "Hello team",
                },
              ],
              hasMore: true,
              nextCursor: "11",
              readPositionAfter: 11,
            },
          };
        }
        if (path.includes("/inbox/dismiss")) {
          return {
            ok: true,
            status: 200,
            data: {
              ok: true,
              mode: "before",
              dismissedConversations: 2,
              dismissedThreads: 1,
              dismissedAppTargets: 1,
              dismissedReminders: 1,
              targets: ["#general", "@app.github", "reminder:0196ed00-0000-7000-8000-000000000009"],
            },
          };
        }
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            messageId: "0196ed00-0000-7000-8000-000000000002",
            state: "cancelled",
          },
        };
      },
    });

    const readRes = await client.inbox.read({ target: "#general", limit: 10, cursor: "5" });
    expect(decodeAgentInboxReadResponse(readRes).nextCursor).toBe("11");

    const dismissRes = await client.inbox.dismiss({ before: "2026-11-16T00:00:00.000Z" });
    expect(decodeAgentInboxDismissResponse(dismissRes).dismissedReminders).toBe(1);

    const withdrawRes = await client.actions.withdraw({
      messageId: "0196ed00-0000-7000-8000-000000000002",
    });
    expect(decodeAgentActionWithdrawResponse(withdrawRes).state).toBe("cancelled");

    expect(agentApiRoutes.cloud.inboxRead.path).toBe("/api/agent/v1/inbox/read");
    expect(agentApiRoutes.cloud.inboxDismiss.path).toBe("/api/agent/v1/inbox/dismiss");
    expect(agentApiRoutes.cloud.actions.withdraw.path).toBe("/api/agent/v1/actions/withdraw");
    expect(calls).toHaveLength(3);
  });
});
