import type { ArtifactDataChangedEvent } from "./artifact-realtime";

type Listener = (event: ArtifactDataChangedEvent) => void;

const listeners = new Set<Listener>();

export const artifactDataEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  emit(event: ArtifactDataChangedEvent) {
    for (const listener of listeners) listener(event);
  },
};
