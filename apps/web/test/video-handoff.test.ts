import { beforeAll, expect, test } from "bun:test";

import { placeOf, resumeAt } from "#src/features/conversations/video-handoff";

beforeAll(() => {
  // Outside a browser: only the ready-state constant is read.
  globalThis.HTMLMediaElement ??= { HAVE_METADATA: 1 } as unknown as typeof HTMLMediaElement;
});

/** The parts of a `<video>` the handoff reads and moves. */
function fakeVideo(state: { currentTime?: number; paused?: boolean; readyState?: number } = {}) {
  const listeners = new Map<string, () => void>();
  const video = {
    currentTime: state.currentTime ?? 0,
    paused: state.paused ?? true,
    ended: false,
    readyState: state.readyState ?? 0,
    play: async () => void (video.paused = false),
    pause: () => void (video.paused = true),
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    fire: (type: string) => listeners.get(type)?.(),
  };
  return video;
}
const asVideo = (video: ReturnType<typeof fakeVideo>) => video as unknown as HTMLVideoElement;

test("a player that never left the start hands over no place", () => {
  expect(placeOf(asVideo(fakeVideo()))).toBeUndefined();
});

test("a player's place is its time and whether it plays", () => {
  expect(placeOf(asVideo(fakeVideo({ currentTime: 12.5, paused: false })))).toEqual({
    time: 12.5,
    playing: true,
  });
  expect(placeOf(asVideo(fakeVideo({ currentTime: 3 })))).toEqual({ time: 3, playing: false });
});

test("the other player carries on from the place once its length is known", () => {
  const video = fakeVideo();
  resumeAt(asVideo(video), { time: 42, playing: true });
  // Before the metadata, a time would be dropped: nothing moves yet.
  expect(video.currentTime).toBe(0);
  video.readyState = 1;
  video.fire("loadedmetadata");
  expect(video.currentTime).toBe(42);
  expect(video.paused).toBe(false);
});

test("a player that knows its length already moves at once, and stays paused for a paused place", () => {
  const video = fakeVideo({ readyState: 4, paused: false });
  resumeAt(asVideo(video), { time: 7, playing: false });
  expect(video.currentTime).toBe(7);
  expect(video.paused).toBe(true);
});
