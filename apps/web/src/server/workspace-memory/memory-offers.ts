/**
 * Memory Offer composition. An offer is a cited channel message to one
 * recipient Agent; it never writes OpenViking.
 */

import type {
  MemoryCitation,
  MemoryHintDelivery,
  OpenVikingOfferCommand,
  MemoryOfferPublication,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryOfferRecord,
  WorkspaceMemoryCitationStore,
} from "#src/server/db/repositories/workspace-memory-citation.repositories.server";
import {
  WorkspaceMemoryCitationKindError,
  WorkspaceMemoryReplayConflictError,
} from "#src/server/db/repositories/workspace-memory-errors.server";
import { WorkspaceMemoryScopeError } from "#src/server/db/repositories/workspace-memory-errors.server";
import { DEFAULT_OFFER_RATIONALE } from "./explicit-memory-answer";
import type { MemoryOfferPublisher } from "./offer-delivery.server";
import { MemoryCitationUngroundedError, type MemoryCitationBindings } from "./memory-citations";

export type MemoryOfferResult = {
  offer: MemoryOfferRecord;
  citations: MemoryCitation[];
  duplicate: boolean;
};

export type MemoryOfferChannel = {
  isMemoryAgent(workspaceId: string, agentId: string): Promise<boolean>;
  isActiveChannelAgent(
    workspaceId: string,
    conversationId: string,
    agentId: string,
  ): Promise<boolean>;
};

export type MemoryOfferHint = {
  conversationId: string;
  targetAgentId: string;
  bodyHash: string;
  sources: readonly { citationId: string }[];
  messageId: string | null;
  deliveredAt: Date | null;
};

export type MemoryOffers = {
  publish(
    input: {
      workspaceId: string;
      operationId: string;
      conversationId: string;
      targetAgentId: string;
      recipientRationale: string;
      citationRefs: string[];
      body: string;
      memoryAgentId: string;
    },
    onPublishing?: () => void,
  ): Promise<MemoryOfferResult>;
  replay(input: {
    workspaceId: string;
    memoryAgentId: string;
    command: OpenVikingOfferCommand;
  }): Promise<MemoryOfferResult | null>;
  publication(
    workspaceId: string,
    memoryAgentId: string,
    operationId: string,
  ): Promise<MemoryOfferPublication | undefined>;
};

export function createMemoryOffers(deps: {
  citations: MemoryCitationBindings;
  offers: Pick<WorkspaceMemoryCitationStore, "putOffer" | "getOffer">;
  publisher: MemoryOfferPublisher;
  channels: MemoryOfferChannel;
  hints: {
    find(
      workspaceId: string,
      memoryAgentId: string,
      operationId: string,
    ): Promise<MemoryOfferHint | null>;
    prepare(input: {
      workspaceId: string;
      operationId: string;
      targetAgentId: string;
      memoryAgentId: string;
      conversationId: string;
      body: string;
      citations: readonly MemoryCitation[];
    }): Promise<MemoryHintDelivery>;
  };
}): MemoryOffers {
  const saveOffer: WorkspaceMemoryCitationStore["putOffer"] = async (input) => {
    try {
      return await deps.offers.putOffer(input);
    } catch (error) {
      if (error instanceof WorkspaceMemoryCitationKindError)
        throw new MemoryCitationUngroundedError();
      throw error;
    }
  };
  return {
    async publication(workspaceId, memoryAgentId, operationId) {
      const hint = await deps.hints.find(workspaceId, memoryAgentId, operationId);
      if (hint?.messageId) return { phase: "published", messageId: hint.messageId };
      // A prepared Hint can belong to an earlier publisher with an unknown outcome.
      // Neither that row nor a delivered Hint whose Message was deleted proves rejection.
      if (hint) return undefined;
      return { phase: "rejected_before_publish" };
    },
    async replay({ workspaceId, memoryAgentId, command }) {
      const hint = await deps.hints.find(workspaceId, memoryAgentId, command.operationId);
      if (hint?.deliveredAt && !hint.messageId)
        throw new WorkspaceMemoryReplayConflictError(command.operationId);
      if (!hint?.messageId) return null;
      const refs = (ids: readonly string[]) => JSON.stringify([...new Set(ids)].sort());
      if (
        hint.bodyHash !== new Bun.CryptoHasher("sha256").update(command.body).digest("hex") ||
        refs(hint.sources.map((source) => source.citationId)) !== refs(command.citationRefs) ||
        (command.conversationId !== undefined && command.conversationId !== hint.conversationId) ||
        (command.targetAgentId !== undefined && command.targetAgentId !== hint.targetAgentId)
      )
        throw new WorkspaceMemoryReplayConflictError(command.operationId);
      const citations = await deps.citations.resolveOfferCitations(
        workspaceId,
        command.citationRefs,
      );
      // Validate the same frozen source versions and body as ordinary Hint replay.
      await deps.hints.prepare({
        workspaceId,
        operationId: command.operationId,
        memoryAgentId,
        conversationId: hint.conversationId,
        targetAgentId: hint.targetAgentId,
        body: command.body,
        citations,
      });
      const existing = await deps.offers.getOffer(workspaceId, command.operationId);
      const saved = await saveOffer(
        existing ?? {
          workspaceId,
          operationId: command.operationId,
          conversationId: hint.conversationId,
          recipientAgentId: hint.targetAgentId,
          recipientRationale: command.recipientRationale?.trim() || DEFAULT_OFFER_RATIONALE,
          messageId: hint.messageId,
          citations: deps.citations.toOfferRefs(citations),
        },
      );
      return { offer: saved.offer, citations, duplicate: true };
    },
    async publish(input, onPublishing) {
      const citations = await deps.citations.resolveOfferCitations(
        input.workspaceId,
        input.citationRefs,
      );
      const existing = await deps.offers.getOffer(input.workspaceId, input.operationId);
      if (existing) return { offer: existing, citations, duplicate: true };
      const active = await deps.channels.isActiveChannelAgent(
        input.workspaceId,
        input.conversationId,
        input.targetAgentId,
      );
      if (
        !active ||
        input.targetAgentId === input.memoryAgentId ||
        (await deps.channels.isMemoryAgent(input.workspaceId, input.targetAgentId))
      )
        throw new WorkspaceMemoryScopeError();
      const memoryHint = await deps.hints.prepare({ ...input, citations });
      onPublishing?.();
      const delivered = await deps.publisher.publish({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        memoryAgentId: input.memoryAgentId,
        recipientAgentId: input.targetAgentId,
        body: input.body,
        requestId: input.operationId,
        memoryHint,
      });
      const saved = await saveOffer({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        conversationId: input.conversationId,
        recipientAgentId: input.targetAgentId,
        recipientRationale: input.recipientRationale,
        messageId: delivered.messageId,
        citations: deps.citations.toOfferRefs(citations),
      });
      return { offer: saved.offer, citations, duplicate: saved.outcome === "replay" };
    },
  };
}
