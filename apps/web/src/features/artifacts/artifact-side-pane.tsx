import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from "react-resizable-panels";

import {
  SIDE_PANE_ENTER,
  useResponsiveSplitLayout,
} from "#src/features/conversations/conversation-split";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ArtifactPage } from "./artifact-page";
import {
  closedArtifactSearch,
  useArtifactNavigation,
  type ArtifactSearch,
} from "./artifact-search";

const CHAT_MIN_REM = 24;
const ARTIFACT_MIN_REM = 26;
const ARTIFACT_DEFAULT_PCT = 54;
const ARTIFACT_MAX_PCT = 78;
const SHIFT_RESIZE_STEP_PCT = 8;

export function ConversationArtifactSplit({
  chat,
  conversationId,
  search,
}: {
  chat: ReactNode;
  conversationId?: string;
  search: ArtifactSearch;
}) {
  const open = search.doc !== undefined;
  const full = Boolean(search.docFull);
  const groupRef = useGroupRef();
  const [dragging, setDragging] = useState(false);
  const { splitRef, splitShown } = useResponsiveSplitLayout({
    active: open && !full,
    mainMinRem: CHAT_MIN_REM,
    sideMinRem: ARTIFACT_MIN_REM,
  });

  const layout = useDefaultLayout({
    id: "coforge-artifact-split",
    panelIds: open ? ["chat", "artifact"] : ["chat"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const group = groupRef.current;
    if (!group) return;
    const current = group.getLayout();
    const chatSize = current.chat;
    const artifactSize = current.artifact;
    if (chatSize === undefined || artifactSize === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === "ArrowLeft" ? -SHIFT_RESIZE_STEP_PCT : SHIFT_RESIZE_STEP_PCT;
    const nextChat = Math.min(80, Math.max(20, chatSize + delta));
    group.setLayout({ chat: nextChat, artifact: 100 - nextChat });
  };

  if (!splitShown) {
    return (
      <div ref={splitRef} className="@container/page flex min-h-0 min-w-0 flex-1">
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", open && "hidden")}>{chat}</div>
        {open && <ConversationArtifactPane conversationId={conversationId} search={search} />}
      </div>
    );
  }

  return (
    <div
      ref={splitRef}
      data-artifact-resizing={dragging ? "true" : undefined}
      className="@container/page flex min-h-0 min-w-0 flex-1 [&[data-artifact-resizing=true]_iframe]:pointer-events-none"
    >
      <Group
        groupRef={groupRef}
        id="artifact-split"
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <Panel
          id="chat"
          minSize={`${CHAT_MIN_REM}rem`}
          hidden={open && full}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {chat}
        </Panel>
        {open && (
          <>
            {!full && (
              <Separator
                aria-label={m.av_resize_artifact_pane()}
                onPointerDown={() => setDragging(true)}
                onDoubleClick={() =>
                  groupRef.current?.setLayout({
                    chat: 100 - ARTIFACT_DEFAULT_PCT,
                    artifact: ARTIFACT_DEFAULT_PCT,
                  })
                }
                onKeyDown={onSeparatorKeyDown}
                className="group/sep relative flex w-px shrink-0 cursor-col-resize items-center justify-center bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid after:absolute after:inset-y-0 after:-inset-x-1.5"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none h-7 w-1 rounded-full bg-fg-quaternary/60 opacity-0 transition-opacity group-hover/sep:opacity-100 group-data-[separator=active]/sep:bg-brand-solid group-data-[separator=active]/sep:opacity-100"
                />
              </Separator>
            )}
            <Panel
              id="artifact"
              defaultSize={`${ARTIFACT_DEFAULT_PCT}%`}
              minSize={`${ARTIFACT_MIN_REM}rem`}
              maxSize={`${ARTIFACT_MAX_PCT}%`}
              className="flex min-h-0 min-w-0 flex-col"
            >
              <div
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col bg-primary",
                  !full && SIDE_PANE_ENTER,
                )}
              >
                <ConversationArtifactPane conversationId={conversationId} search={search} />
              </div>
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

export function ConversationArtifactPane({
  conversationId,
  search,
}: {
  conversationId?: string;
  search: ArtifactSearch;
}) {
  const navigate = useArtifactNavigation();
  if (search.doc === undefined) return null;
  const pane = {
    full: Boolean(search.docFull),
    onToggleFull: () => navigate({ docFull: search.docFull ? undefined : true }, { replace: true }),
    onClose: () => navigate(closedArtifactSearch, { replace: true }),
    conversationId,
    onSwitchArtifact: (artifactId: string) => navigate({ doc: artifactId }, { replace: true }),
  };
  return <ArtifactPage artifactId={search.doc} pane={pane} />;
}
