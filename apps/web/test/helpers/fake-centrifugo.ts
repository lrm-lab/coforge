import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/** A Centrifugo whose every call succeeds and publishes nothing, for a test that ignores realtime. */
export function quietCentrifugo(): CentrifugoServerApi {
  return withPublishBatch({
    publish: async () => {},
    publishJson: async () => {},
    broadcast: async () => {},
  });
}

/**
 * Gives a fake Centrifugo the `publishBatch` its `publish` implies: each publication goes through
 * the fake's own `publish` and settles on its own, as Centrifugo's batch replies do. A test that
 * records or fails `publish` sees batched pushes exactly as it saw one-by-one ones.
 */
export function withPublishBatch<T extends Pick<CentrifugoServerApi, "publish">>(
  api: T,
): NoInfer<T> & Pick<CentrifugoServerApi, "publishBatch"> {
  return Object.assign(api, {
    publishBatch: (publications: Parameters<CentrifugoServerApi["publishBatch"]>[0]) =>
      Promise.allSettled(publications.map(async ({ channel, data }) => api.publish(channel, data))),
  });
}

/** A quiet Centrifugo that keeps every Agent delivery it is asked to push, decoded, in order. */
export function recordingDeliveries() {
  const delivered: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
  const publisher: CentrifugoServerApi = withPublishBatch({
    ...quietCentrifugo(),
    publish: async (_channel: string, payload: Uint8Array) => {
      delivered.push(decodeAgentMessageDelivery(payload));
    },
  });
  return { publisher, delivered };
}
