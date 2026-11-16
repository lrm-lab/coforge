export type ComposerRequest = { body?: string };

type Handler = (request: ComposerRequest) => void;

const handlers = new Set<Handler>();

export const artifactComposerRequests = {
  subscribe(handler: Handler): () => void {
    handlers.add(handler);
    return () => void handlers.delete(handler);
  },
  request(request: ComposerRequest): boolean {
    for (const handler of handlers) handler(request);
    return handlers.size > 0;
  },
};
