import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowUpRight,
  CheckCircle,
  DotsHorizontal,
  Link01,
  LinkExternal01,
  RefreshCcw01,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { copyText } from "#src/lib/clipboard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { artifactHomeConversation } from "./artifact-queries";
import type { GalleryCard } from "./artifact-scope";
import { artifactPageRoute } from "./artifact-search";
import { encodeArtifactShortId, publicArtifactPath } from "./artifact-short-id";
import { useArtifactSettlement } from "./use-artifact-settlement";

type MenuCard = Pick<GalleryCard, "id" | "title" | "homeKey" | "access" | "settled" | "reopened">;

function hasSelectionInside(target: HTMLElement): boolean {
  const selection = target.ownerDocument.defaultView?.getSelection?.() ?? null;
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    selection.containsNode(target, true),
  );
}

function restoreGalleryFocus(container: Element | null, previousIndex: number) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  if (container?.isConnected) {
    const links = [...container.querySelectorAll<HTMLElement>("[data-artifact-open]")];
    const next = links[Math.min(Math.max(previousIndex, 0), links.length - 1)] ?? null;
    if (next) {
      next.focus();
      return;
    }
  }
  document.querySelector<HTMLElement>("[data-artifact-settled-strip-action]")?.focus();
}

export function useGalleryCardMenu(card: MenuCard) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const toast = useAppToast();
  const [open, setOpen] = useState(false);
  const [anchorMode, setAnchorMode] = useState<"button" | "pointer-anchor">("button");
  const cardRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pointerAnchorRef = useRef<HTMLSpanElement | null>(null);
  const displayTitle = card.title || m.doc_untitled();
  const homeId = artifactHomeConversation(card.homeKey);
  const settlement = useArtifactSettlement({
    artifactId: card.id,
    homeId,
    settled: card.settled,
    reopened: card.reopened,
  });

  const fullPageHref = router.buildLocation(
    artifactPageRoute(workspaceSlug, encodeArtifactShortId(card.id)),
  ).publicHref;

  const shareUrl = () =>
    card.access === "link"
      ? `${window.location.origin}${publicArtifactPath(card.id)}`
      : `${window.location.origin}${fullPageHref}`;

  const openMenuAt = useCallback((x: number, y: number) => {
    const anchor = pointerAnchorRef.current;
    if (anchor) {
      anchor.style.left = `${x}px`;
      anchor.style.top = `${y}px`;
    }
    setAnchorMode("pointer-anchor");
    setOpen(true);
  }, []);

  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (hasSelectionInside(event.currentTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      openMenuAt(event.clientX, event.clientY);
    },
    [openMenuAt],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuAt(
        rect.left + Math.min(24, rect.width / 2),
        rect.top + Math.min(24, rect.height / 2),
      );
    },
    [openMenuAt],
  );

  const onAction = async (key: string) => {
    if (key === "open") {
      void router.navigate({
        to: "/w/$workspaceSlug/artifacts",
        params: { workspaceSlug },
        search: { artifact: card.id },
        resetScroll: false,
      });
      return;
    }
    if (key === "open-new-page") {
      window.open(fullPageHref, "_blank", "noopener,noreferrer");
      return;
    }
    if (key === "copy-link") {
      if (await copyText(shareUrl())) toast.success(m.doc_link_copied());
      else toast.error(m.conversation_copy_failed());
      return;
    }
    if (key === "toggle-settlement") {
      const el = cardRef.current;
      const list = el?.closest("[data-artifact-gallery-items]") ?? null;
      const index =
        list && el
          ? [...list.querySelectorAll("[data-artifact-open]")].findIndex((link) =>
              el.contains(link),
            )
          : -1;
      const changed = await (card.settled ? settlement.unsettle() : settlement.settle());
      if (changed) {
        requestAnimationFrame(() => restoreGalleryFocus(list, index));
      }
    }
  };

  const renderMenu = (triggerClassName?: string) => (
    <Dropdown.Root isOpen={open} onOpenChange={setOpen}>
      <span
        ref={pointerAnchorRef}
        aria-hidden="true"
        className="pointer-events-none fixed z-50 size-0"
      />
      <AriaButton
        ref={buttonRef}
        aria-label={m.ag_card_actions({ title: displayTitle })}
        data-artifact-card-menu-trigger=""
        data-open={open ? "true" : undefined}
        onPressStart={() => setAnchorMode("button")}
        className={cn(
          "relative z-10 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-tertiary outline-focus-ring transition-[color,background-color,opacity] duration-150 hover:bg-primary_hover hover:text-fg-secondary focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-2",
          triggerClassName,
        )}
      >
        <DotsHorizontal aria-hidden="true" className="size-4" />
      </AriaButton>
      <Dropdown.Popover
        triggerRef={anchorMode === "pointer-anchor" ? pointerAnchorRef : buttonRef}
        placement={anchorMode === "pointer-anchor" ? "bottom start" : "bottom end"}
      >
        <Dropdown.Menu aria-label={displayTitle} onAction={(key) => void onAction(String(key))}>
          <Dropdown.Item id="open" icon={ArrowUpRight} label={m.ag_menu_open()} />
          <Dropdown.Item
            id="open-new-page"
            icon={LinkExternal01}
            label={m.ag_menu_open_new_page()}
          />
          <Dropdown.Separator />
          <Dropdown.Item id="copy-link" icon={Link01} label={m.ag_menu_copy_link()} />
          <Dropdown.Separator />
          <Dropdown.Item
            id="toggle-settlement"
            leading={
              card.settled ? (
                <RefreshCcw01
                  aria-hidden="true"
                  className="size-[1.125rem] shrink-0 stroke-[1.9px]"
                />
              ) : (
                <CheckCircle
                  aria-hidden="true"
                  className="size-[1.125rem] shrink-0 stroke-[1.9px] text-utility-green-500"
                />
              )
            }
            isDisabled={settlement.pending}
            label={card.settled ? m.av_unsettle_action() : m.av_settle_action()}
          />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );

  return {
    cardRef,
    onContextMenu,
    onKeyDown,
    renderMenu,
  };
}
