import { expect, test } from "bun:test";

import { ConversationBottomPin } from "#src/features/conversations/conversation-bottom-pin";

/**
 * Where a pane opens (task #192). An open row the history cannot scroll far enough for lands at
 * the bottom; content that fills in afterwards (reactions, a thread's preview) must carry the
 * reader along, though native scroll anchoring's scroll event reaches the pin before the resize.
 */
function fakeHistory({
  scrollHeight,
  clientHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
}) {
  let top = 0;
  const history = {
    scrollHeight,
    clientHeight,
    // A browser clamps the scroll position to what the content allows.
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.min(Math.max(0, value), history.scrollHeight - history.clientHeight);
    },
    scrollTo(options: { top: number }) {
      history.scrollTop = options.top;
    },
    getBoundingClientRect: () => ({ top: 0 }),
  };
  return history;
}
const rowAt = (top: number, history: { scrollTop: number }) => ({
  getBoundingClientRect: () => ({ top: top - history.scrollTop }),
});

test("an open row that fits above the end lands at the bottom and stays pinned through growth", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 2124, clientHeight: 577 });
  // The last row starts 300px above the end: scrolling its top into place would pass the bottom.
  const pinned = pin.open(history as never, rowAt(1824, history) as never);
  expect(pinned).toBe(true);
  expect(history.scrollTop).toBe(2124 - 577);
  // Rows above grow; native scroll anchoring moves the position part of the way and its scroll
  // event arrives first. It is not the reader moving away, so the resize still re-pins.
  history.scrollHeight = 2242;
  history.scrollTop += 71;
  expect(pin.scroll(history)).toBeUndefined();
  expect(pin.beforeResize(history)).toBe(true);
});

test("an open row with history below it scrolls its top into place and does not pin", () => {
  const pin = new ConversationBottomPin();
  const history = fakeHistory({ scrollHeight: 4000, clientHeight: 577 });
  const pinned = pin.open(history as never, rowAt(1000, history) as never);
  expect(pinned).toBe(false);
  expect(history.scrollTop).toBe(1000 - 12);
});
