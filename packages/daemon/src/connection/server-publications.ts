import {
  decodeAgentServerFeatures,
  decodeAppConfigSync,
  type AgentServerFeatures,
  type AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import { ListenerSlot } from "./listener-slot";
import { ReadyPublicationHold } from "./ready-publication-hold";

/** Binary server publications that share ready buffering but do not target one Agent. */
export class ServerPublications {
  readonly appConfig = new ListenerSlot<(sync: AppConfigSync) => void>();
  readonly features = new ListenerSlot<(sync: AgentServerFeatures) => void>();

  onAppConfigSync(callback: (sync: AppConfigSync) => void): () => void {
    return this.appConfig.set(callback);
  }

  onAgentServerFeatures(callback: (sync: AgentServerFeatures) => void): () => void {
    return this.features.set(callback);
  }

  clear(): void {
    this.appConfig.clear();
    this.features.clear();
  }

  route(
    data: Uint8Array,
    scope: { workspaceId: string; computerId: string },
    ready: ReadyPublicationHold,
  ): boolean {
    try {
      const sync = decodeAppConfigSync(data);
      if (sync.workspaceId !== scope.workspaceId || sync.computerId !== scope.computerId)
        return false;
      ready.deliver(this.appConfig, sync);
      return true;
    } catch {
      // Try the next publication kind.
    }
    try {
      const features = decodeAgentServerFeatures(data);
      if (features.workspaceId !== scope.workspaceId || features.computerId !== scope.computerId)
        return false;
      ready.deliver(this.features, features);
      return true;
    } catch {
      return false;
    }
  }
}
