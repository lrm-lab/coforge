import { useServerFn } from "@tanstack/react-start";
import type { Dispatch, SetStateAction } from "react";

import {
  requestAppPublish,
  requestAppUnpublish,
  withdrawAppPublish,
} from "./app-publishing.functions";
import type { AppSummary } from "./apps.functions";

/**
 * The Marketplace review requests of Settings → Applications. Each runs at once, puts the status
 * the server answered into the list, and throws when the server refuses it. `guarded` is the
 * page's `refreshingWhenStale`, so a gone app makes the page read its list again.
 */
export function useAppPublishing(
  setApps: Dispatch<SetStateAction<AppSummary[] | undefined>>,
  guarded: (action: () => Promise<void>) => Promise<void>,
) {
  const request = useServerFn(requestAppPublish);
  const withdraw = useServerFn(withdrawAppPublish);
  const unpublish = useServerFn(requestAppUnpublish);
  const run =
    (call: typeof request) =>
    (app: AppSummary): Promise<void> =>
      guarded(async () => {
        const { publishStatus } = await call({ data: { key: app.key } });
        setApps((current) =>
          current?.map((held) => (held.key === app.key ? { ...held, publishStatus } : held)),
        );
      });
  return {
    requestPublish: run(request),
    withdrawPublish: run(withdraw),
    requestUnpublish: run(unpublish),
  };
}
