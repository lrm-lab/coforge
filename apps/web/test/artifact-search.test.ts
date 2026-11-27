import { describe, expect, test } from "bun:test";

import {
  closedArtifactSearch,
  conversationSearchWithArtifact,
  openArtifactSearch,
} from "#src/features/artifacts/artifact-search";
import { conversationSearchForThread } from "#src/features/conversations/conversation-thread-search";

describe("conversationSearchWithArtifact", () => {
  test("strips thread, profile and details when opening a document while preserving conversation view", () => {
    expect(
      conversationSearchWithArtifact(
        {
          view: "chat",
          threadRootId: "thread-1",
          profile: "agent:a1",
          agentTab: "profile",
          details: "panel",
          docFull: true,
        },
        openArtifactSearch("doc-2"),
      ),
    ).toEqual({
      view: "chat",
      doc: "doc-2",
      docFull: undefined,
    });
  });

  test("preserves existing docFull when switching documents without resetting docFull", () => {
    expect(
      conversationSearchWithArtifact(
        {
          view: "chat",
          doc: "doc-1",
          docFull: true,
          profile: "agent:a1",
        },
        { doc: "doc-2" },
      ),
    ).toEqual({
      view: "chat",
      doc: "doc-2",
      docFull: true,
    });
  });

  test("closing a document leaves unrelated search params intact", () => {
    expect(
      conversationSearchWithArtifact(
        {
          view: "files",
          doc: "doc-1",
          docFull: true,
        },
        closedArtifactSearch,
      ),
    ).toEqual({
      view: "files",
      doc: undefined,
      docFull: undefined,
    });
  });
});

describe("conversationSearchForThread", () => {
  test("strips details and open document while preserving an open profile when opening a thread", () => {
    expect(
      conversationSearchForThread({
        view: "chat",
        profile: "agent:a1",
        agentTab: "reminders",
        details: "members",
        doc: "doc-1",
        docFull: true,
      }),
    ).toEqual({
      view: "chat",
      profile: "agent:a1",
      agentTab: "reminders",
    });
  });
});
