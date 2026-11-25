import { createElement } from "react";
import { describe, expect, test } from "bun:test";
import {
  BUTTON_LOADING_EXIT_DURATION_MS,
  BUTTON_LOADING_MIN_VISIBLE_MS,
  BUTTON_LOADING_SHOW_DELAY_MS,
  createButtonLoadingState,
  resolveButtonLoadingPresentation,
  stepButtonLoadingTimer,
  syncButtonLoadingState,
  type ButtonLoadingSnapshot,
} from "#src/components/ui/loading";

function IconA({ className }: { className?: string }) {
  return createElement("svg", { className, "data-icon-test": "a" });
}

function IconB({ className }: { className?: string }) {
  return createElement("svg", { className, "data-icon-test": "b" });
}

interface ContentShape {
  children: unknown;
  iconLeading?: unknown;
  iconTrailing?: unknown;
}

function makeSnapshot(
  children: unknown,
  overrides: {
    iconLeading?: unknown;
    iconTrailing?: unknown;
    color?: string;
    size?: string;
    href?: string;
    ariaLabel?: string;
    ariaLabelledBy?: string;
  } = {},
): ButtonLoadingSnapshot<ContentShape> {
  return {
    content: {
      children,
      iconLeading: overrides.iconLeading,
      iconTrailing: overrides.iconTrailing,
    },
    intent: {
      color: overrides.color ?? "primary",
      size: overrides.size ?? "sm",
      href: overrides.href,
      ariaLabel: overrides.ariaLabel,
      ariaLabelledBy: overrides.ariaLabelledBy,
    },
  };
}

describe("useButtonLoadingTransition state machine", () => {
  test("ends transition immediately when visible loading stops with changed label", () => {
    const createSnap = makeSnapshot("Create");
    const creatingSnap = makeSnapshot("Creating…");
    const renameSnap = makeSnapshot("Rename…");

    const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 1000,
      currentSnapshot: creatingSnap,
      idleSnapshot: createSnap,
      idleWidth: 84,
    });
    expect(started.state.phase).toBe("delaying");
    expect(started.nextTimer).toEqual({ kind: "show", delayMs: BUTTON_LOADING_SHOW_DELAY_MS });

    const shown = stepButtonLoadingTimer(started.state, "show", 1150);
    expect(shown.state.phase).toBe("visible");

    const immediatePresentation = resolveButtonLoadingPresentation(shown.state, false, renameSnap);
    expect(immediatePresentation).toEqual({
      showIndicator: false,
      loadingActive: false,
      lockedWidth: null,
      frozenContent: null,
    });

    const synced = syncButtonLoadingState(shown.state, {
      loading: false,
      now: 1200,
      currentSnapshot: renameSnap,
      idleSnapshot: createSnap,
      idleWidth: 84,
    });
    expect(synced.state.phase).toBe("idle");
    expect(synced.state.lockedWidth).toBeNull();
    expect(synced.state.frozenSnapshot).toBeNull();
    expect(synced.nextTimer).toBeNull();
  });

  test("ends transition immediately when iconLeading, color, size, or aria-label changes on completion", () => {
    const scenarios = [
      {
        name: "iconLeading element changes",
        before: makeSnapshot("Copy", {
          iconLeading: createElement(IconA, { className: "size-4" }),
        }),
        after: makeSnapshot("Copy", { iconLeading: createElement(IconB, { className: "size-4" }) }),
      },
      {
        name: "color tone changes",
        before: makeSnapshot("Save", { color: "primary" }),
        after: makeSnapshot("Save", { color: "primary-destructive" }),
      },
      {
        name: "size changes",
        before: makeSnapshot("Save", { size: "sm" }),
        after: makeSnapshot("Save", { size: "md" }),
      },
      {
        name: "aria-label changes",
        before: makeSnapshot(undefined, { iconLeading: IconA, ariaLabel: "Follow" }),
        after: makeSnapshot(undefined, { iconLeading: IconA, ariaLabel: "Unfollow" }),
      },
    ];

    for (const scenario of scenarios) {
      const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
        loading: true,
        now: 100,
        currentSnapshot: scenario.before,
        idleSnapshot: scenario.before,
        idleWidth: 72,
      });
      const shown = stepButtonLoadingTimer(started.state, "show", 250);
      expect(resolveButtonLoadingPresentation(shown.state, false, scenario.after)).toEqual({
        showIndicator: false,
        loadingActive: false,
        lockedWidth: null,
        frozenContent: null,
      });
      const synced = syncButtonLoadingState(shown.state, {
        loading: false,
        now: 300,
        currentSnapshot: scenario.after,
        idleSnapshot: scenario.before,
        idleWidth: 72,
      });
      expect(synced.state.phase).toBe("idle");
      expect(synced.nextTimer).toBeNull();
    }
  });

  test("cancels mid-holding or mid-exiting immediately when content or intent changes after loading ended", () => {
    const before = makeSnapshot("Save");
    const after = makeSnapshot("Retry");

    const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 1000,
      currentSnapshot: before,
      idleSnapshot: before,
      idleWidth: 68,
    });
    const shown = stepButtonLoadingTimer(started.state, "show", 1150);
    const holding = syncButtonLoadingState(shown.state, {
      loading: false,
      now: 1200,
      currentSnapshot: before,
      idleSnapshot: before,
      idleWidth: 68,
    });
    expect(holding.state.phase).toBe("holding");
    expect(holding.nextTimer).toEqual({
      kind: "hold-end",
      delayMs: BUTTON_LOADING_MIN_VISIBLE_MS - 50,
    });

    expect(resolveButtonLoadingPresentation(holding.state, false, after)).toEqual({
      showIndicator: false,
      loadingActive: false,
      lockedWidth: null,
      frozenContent: null,
    });
    const cancelledHold = syncButtonLoadingState(holding.state, {
      loading: false,
      now: 1250,
      currentSnapshot: after,
      idleSnapshot: before,
      idleWidth: 68,
    });
    expect(cancelledHold.state.phase).toBe("idle");
    expect(cancelledHold.nextTimer).toBeNull();

    const exiting = stepButtonLoadingTimer(holding.state, "hold-end", 1550);
    expect(exiting.state.phase).toBe("exiting");
    expect(resolveButtonLoadingPresentation(exiting.state, false, after)).toEqual({
      showIndicator: false,
      loadingActive: false,
      lockedWidth: null,
      frozenContent: null,
    });
    const cancelledExit = syncButtonLoadingState(exiting.state, {
      loading: false,
      now: 1600,
      currentSnapshot: after,
      idleSnapshot: before,
      idleWidth: 68,
    });
    expect(cancelledExit.state.phase).toBe("idle");
    expect(cancelledExit.nextTimer).toBeNull();
  });

  test("preserves full min-visible and exit transition when content and freshly created JSX icons remain unchanged", () => {
    const idleSnap = makeSnapshot("Save", {
      iconLeading: createElement(IconA, { className: "size-4" }),
    });
    const busySnap = makeSnapshot("Saving…", {
      iconLeading: createElement(IconA, { className: "size-4" }),
    });
    const doneUnchangedSnap = makeSnapshot("Save", {
      iconLeading: createElement(IconA, { className: "size-4" }),
    });

    const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 2000,
      currentSnapshot: busySnap,
      idleSnapshot: idleSnap,
      idleWidth: 96,
    });
    const shown = stepButtonLoadingTimer(started.state, "show", 2150);

    const presentationHolding = resolveButtonLoadingPresentation(
      shown.state,
      false,
      doneUnchangedSnap,
    );
    expect(presentationHolding).toEqual({
      showIndicator: true,
      loadingActive: true,
      lockedWidth: 96,
      frozenContent: idleSnap.content,
    });

    const holding = syncButtonLoadingState(shown.state, {
      loading: false,
      now: 2230,
      currentSnapshot: doneUnchangedSnap,
      idleSnapshot: idleSnap,
      idleWidth: 96,
    });
    expect(holding.state.phase).toBe("holding");
    expect(holding.nextTimer).toEqual({
      kind: "hold-end",
      delayMs: BUTTON_LOADING_MIN_VISIBLE_MS - 80,
    });

    const exiting = stepButtonLoadingTimer(holding.state, "hold-end", 2550);
    expect(exiting.state.phase).toBe("exiting");
    expect(exiting.nextTimer).toEqual({
      kind: "exit-end",
      delayMs: BUTTON_LOADING_EXIT_DURATION_MS,
    });
    expect(resolveButtonLoadingPresentation(exiting.state, false, doneUnchangedSnap)).toEqual({
      showIndicator: false,
      loadingActive: true,
      lockedWidth: 96,
      frozenContent: idleSnap.content,
    });

    const finished = stepButtonLoadingTimer(exiting.state, "exit-end", 2750);
    expect(finished.state.phase).toBe("idle");
    expect(finished.state.lockedWidth).toBeNull();
    expect(finished.state.frozenSnapshot).toBeNull();
    expect(finished.nextTimer).toBeNull();
  });

  test("cancels delaying phase immediately without spinner or exit when loading finishes before show delay", () => {
    const snap = makeSnapshot("Save");
    const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 500,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 64,
    });
    expect(started.state.phase).toBe("delaying");

    const finished = syncButtonLoadingState(started.state, {
      loading: false,
      now: 560,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 64,
    });
    expect(finished.state.phase).toBe("idle");
    expect(finished.state.lockedWidth).toBeNull();
    expect(finished.state.frozenSnapshot).toBeNull();
    expect(finished.nextTimer).toBeNull();
  });

  test("second loading cycle after immediate unfreeze locks new label and width with a fresh delay", () => {
    const createSnap = makeSnapshot("Create");
    const creatingSnap = makeSnapshot("Creating…");
    const retrySnap = makeSnapshot("Retry");

    const firstStart = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 100,
      currentSnapshot: creatingSnap,
      idleSnapshot: createSnap,
      idleWidth: 80,
    });
    const firstShown = stepButtonLoadingTimer(firstStart.state, "show", 250);
    const firstAborted = syncButtonLoadingState(firstShown.state, {
      loading: false,
      now: 300,
      currentSnapshot: retrySnap,
      idleSnapshot: createSnap,
      idleWidth: 80,
    });
    expect(firstAborted.state.phase).toBe("idle");

    const secondStart = syncButtonLoadingState(firstAborted.state, {
      loading: true,
      now: 400,
      currentSnapshot: creatingSnap,
      idleSnapshot: retrySnap,
      idleWidth: 66,
    });
    expect(secondStart.state.phase).toBe("delaying");
    expect(secondStart.state.enteredAt).toBe(400);
    expect(secondStart.state.shownAt).toBe(0);
    expect(secondStart.state.lockedWidth).toBe(66);
    expect(secondStart.state.frozenSnapshot).toBe(retrySnap);
    expect(secondStart.nextTimer).toEqual({ kind: "show", delayMs: BUTTON_LOADING_SHOW_DELAY_MS });
  });

  test("re-entering loading during holding or exiting preserves frozen width and snapshot seamlessly", () => {
    const snap = makeSnapshot("Save");
    const started = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 1000,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 74,
    });
    const shown = stepButtonLoadingTimer(started.state, "show", 1150);
    const holding = syncButtonLoadingState(shown.state, {
      loading: false,
      now: 1200,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 74,
    });

    const resumedDuringHold = syncButtonLoadingState(holding.state, {
      loading: true,
      now: 1250,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 99,
    });
    expect(resumedDuringHold.state.phase).toBe("visible");
    expect(resumedDuringHold.state.lockedWidth).toBe(74);
    expect(resumedDuringHold.state.frozenSnapshot).toBe(snap);
    expect(resumedDuringHold.nextTimer).toBeNull();

    const exiting = stepButtonLoadingTimer(holding.state, "hold-end", 1550);
    const resumedDuringExit = syncButtonLoadingState(exiting.state, {
      loading: true,
      now: 1620,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 99,
    });
    expect(resumedDuringExit.state.phase).toBe("delaying");
    expect(resumedDuringExit.state.lockedWidth).toBe(74);
    expect(resumedDuringExit.state.frozenSnapshot).toBe(snap);
    expect(resumedDuringExit.nextTimer).toEqual({
      kind: "show",
      delayMs: BUTTON_LOADING_SHOW_DELAY_MS,
    });
  });

  test("re-syncing during delaying, holding, or exiting preserves timestamps and recomputes remaining delay", () => {
    const snap = makeSnapshot("Save");
    const delaying = syncButtonLoadingState(createButtonLoadingState<ContentShape>(), {
      loading: true,
      now: 1000,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 70,
    }).state;

    const resyncDelaying = syncButtonLoadingState(delaying, {
      loading: true,
      now: 1040,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 70,
    });
    expect(resyncDelaying.state.enteredAt).toBe(1000);
    expect(resyncDelaying.nextTimer).toEqual({
      kind: "show",
      delayMs: BUTTON_LOADING_SHOW_DELAY_MS - 40,
    });

    const shown = stepButtonLoadingTimer(resyncDelaying.state, "show", 1150).state;
    const holding = syncButtonLoadingState(shown, {
      loading: false,
      now: 1200,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 70,
    }).state;
    const resyncHolding = syncButtonLoadingState(holding, {
      loading: false,
      now: 1275,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 70,
    });
    expect(resyncHolding.state.shownAt).toBe(1150);
    expect(resyncHolding.nextTimer).toEqual({
      kind: "hold-end",
      delayMs: BUTTON_LOADING_MIN_VISIBLE_MS - 125,
    });

    const exiting = stepButtonLoadingTimer(resyncHolding.state, "hold-end", 1550).state;
    const resyncExiting = syncButtonLoadingState(exiting, {
      loading: false,
      now: 1610,
      currentSnapshot: snap,
      idleSnapshot: snap,
      idleWidth: 70,
    });
    expect(resyncExiting.state.exitedAt).toBe(1550);
    expect(resyncExiting.nextTimer).toEqual({
      kind: "exit-end",
      delayMs: BUTTON_LOADING_EXIT_DURATION_MS - 60,
    });
  });
});
