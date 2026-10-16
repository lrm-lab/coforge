import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  chatSectionOrderQuery,
  chatSectionOrderReady,
  type ChatSectionsApi,
} from "#src/features/conversations/chat-sections";

const unused = async () => {
  throw new Error("not called");
};

/**
 * The section order as the sidebar's hook sees it: a tracked result that renders again only when a
 * property the hook reads changes, and each render works out whether a drag may start.
 */
function sidebarOrder(reads: Array<() => Promise<string[]>>) {
  const api: ChatSectionsApi = {
    list: unused,
    order: () => reads.shift()!(),
    create: unused,
    update: unused,
    remove: unused,
    reorder: unused,
    move: unused,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = chatSectionOrderQuery("w1", api);
  const observer = new QueryObserver(queryClient, options);
  const renders: boolean[] = [];
  const render = () => {
    const result = observer.trackResult(observer.getCurrentResult());
    void result.data;
    renders.push(
      chatSectionOrderReady({
        status: result.status,
        isInvalidated: queryClient.getQueryState(options.queryKey)?.isInvalidated ?? false,
      }),
    );
  };
  render();
  const unsubscribe = observer.subscribe(render);
  return { queryClient, options, renders, unsubscribe };
}

/** A read the test settles. */
function gate() {
  let settle!: (order: string[]) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<string[]>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { read: () => promise, settle, fail };
}

/**
 * Sections may be dragged only from the order the server holds now: a drag saves the whole order,
 * so one made from a restored copy would overwrite a reorder made on another device since.
 */
describe("chatSectionOrderReady, as the sidebar renders it", () => {
  test("is true once the order was read", async () => {
    const order = sidebarOrder([async () => ["pinned", "channels"]]);
    await order.queryClient.fetchQuery(order.options);

    expect(order.renders.at(-1)).toBe(true);
    order.unsubscribe();
  });

  test("is false while the read after a restore is under way, and after it fails", async () => {
    const followUp = gate();
    // The browser copy comes back as the query's first result; then the query is invalidated and
    // read again (`query-cache-persistence.ts`).
    const order = sidebarOrder([async () => ["pinned", "channels"], followUp.read]);
    await order.queryClient.fetchQuery(order.options);
    const reading = order.queryClient.invalidateQueries({ queryKey: order.options.queryKey });

    expect(order.renders.at(-1)).toBe(false);
    followUp.fail(new Error("read failed"));
    await reading;
    expect(order.renders.at(-1)).toBe(false);
    order.unsubscribe();
  });

  test("is true when the read after a restore succeeds", async () => {
    const followUp = gate();
    const order = sidebarOrder([async () => ["pinned", "channels"], followUp.read]);
    await order.queryClient.fetchQuery(order.options);
    const reading = order.queryClient.invalidateQueries({ queryKey: order.options.queryKey });
    followUp.settle(["channels", "pinned"]);
    await reading;

    expect(order.renders.at(-1)).toBe(true);
    order.unsubscribe();
  });
});
