import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy01, DotsVertical, Flag01, Link01, LinkExternal01, XClose } from "@untitledui/icons";
import { CircleAlert } from "kubai-icons/duotone";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { EmptyState } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { buildAiPromptUrl, formatArtifactForAi, type AiProvider } from "./artifact-ai-shortcuts";
import { publicArtifactPath } from "./artifact-short-id";
import { PublicArtifactReportDialog } from "./public-artifact-dialogs";

const BANNER_DISMISSED_KEY = "coforge.artifacts.publicBannerDismissed";

function readBannerDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BANNER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveBannerDismissed(): void {
  try {
    window.localStorage.setItem(BANNER_DISMISSED_KEY, "1");
  } catch {
    return;
  }
}

export type PublicArtifactData = {
  artifactId: string;
  title: string;
  url: string;
  version: number;
  updatedAt?: string;
};

type MenuAction = "copy-link" | "copy-for-ai" | AiProvider | "report";

export function PublicArtifactShell({
  artifact,
  signedIn = false,
  rateLimited = false,
  returnTo,
}: {
  artifact: PublicArtifactData | null;
  signedIn?: boolean;
  rateLimited?: boolean;
  returnTo?: string;
}) {
  const toast = useAppToast();
  const navigate = useNavigate();
  const [reporting, setReporting] = useState(false);
  const [phonePromptOpen, setPhonePromptOpen] = useState(() => !readBannerDismissed());

  const openSignIn = () => {
    void navigate({
      to: "/login",
      search: returnTo ? { returnTo } : {},
    });
  };

  const dismissPhonePrompt = () => {
    saveBannerDismissed();
    setPhonePromptOpen(false);
  };

  if (!artifact) {
    const openApp = (
      <Button
        size="sm"
        color={signedIn ? "primary" : "secondary"}
        onPress={() => void navigate({ to: "/" })}
      >
        {m.ap_open_in_coforge()}
      </Button>
    );
    return (
      <main className="flex min-h-dvh flex-col bg-primary">
        <EmptyState
          headingLevel={1}
          role={rateLimited ? "alert" : undefined}
          picture={rateLimited ? <EmptyIcon icon={CircleAlert} /> : <LockedWireframe />}
          title={m.ap_unavailable_title()}
          description={rateLimited ? m.ap_rate_limited() : m.ap_unavailable_body()}
          primaryAction={
            signedIn ? (
              openApp
            ) : (
              <Button size="sm" color="primary" onPress={openSignIn}>
                {m.ap_sign_in_to_view()}
              </Button>
            )
          }
          secondaryAction={signedIn ? undefined : openApp}
        />
      </main>
    );
  }

  const title = artifact.title || m.doc_untitled();
  const shareUrl =
    typeof window === "undefined"
      ? publicArtifactPath(artifact.artifactId)
      : `${window.location.origin}${publicArtifactPath(artifact.artifactId)}`;

  const copyLink = async () => {
    if (await copyText(shareUrl)) toast.success(m.doc_link_copied());
    else toast.error(m.conversation_copy_failed());
  };

  const onMenuAction = async (action: MenuAction) => {
    if (action === "copy-link") {
      await copyLink();
      return;
    }
    if (action === "report") {
      setReporting(true);
      return;
    }
    const context = { title, version: artifact.version, url: shareUrl };
    if (action === "copy-for-ai") {
      if (await copyText(formatArtifactForAi(context))) toast.success(m.av_ai_copied());
      else toast.error(m.conversation_copy_failed());
      return;
    }
    window.open(buildAiPromptUrl(action, context), "_blank", "noopener,noreferrer");
  };

  return (
    <main className="flex h-dvh flex-col bg-primary">
      {!signedIn && (
        <div className="hidden min-h-12 shrink-0 items-center justify-center gap-5 border-b border-secondary bg-secondary px-5 py-2 text-sm text-primary sm:flex">
          <p className="min-w-0">{m.ap_visitor_prompt()}</p>
          <Button size="sm" color="secondary" onPress={openSignIn}>
            {m.ap_sign_up_or_in()}
          </Button>
        </div>
      )}

      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2.5 border-b border-secondary bg-primary px-3 py-1.5 sm:h-12 sm:px-4 sm:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Link
            to="/"
            aria-label="CoForge"
            className="flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <CoForgeMark className="h-4.5" />
          </Link>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-primary">{title}</h1>
              <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset">
                v{artifact.version}
              </span>
            </div>

            <div className="flex min-w-0 items-center gap-2 text-xs text-tertiary">
              <span className="shrink-0">{m.ap_unverified()}</span>
              {artifact.updatedAt && (
                <span className="truncate">
                  {m.ap_updated_prefix()} <RelativeTime value={artifact.updatedAt} plain />
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {signedIn ? (
            <Button size="sm" color="secondary" onPress={() => void navigate({ to: "/" })}>
              {m.ap_open_in_coforge()}
            </Button>
          ) : (
            <Button size="sm" color="secondary" onPress={openSignIn}>
              {m.ap_sign_in_to_view()}
            </Button>
          )}

          <Dropdown.Root>
            <ButtonUtility
              icon={DotsVertical}
              size="sm"
              color="tertiary"
              tooltip={m.ap_more_actions()}
            />
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={m.ap_more_actions()}
                onAction={(key) => void onMenuAction(key as MenuAction)}
              >
                <Dropdown.Item id="copy-link" icon={Link01} label={m.doc_copy_link()} />
                {!signedIn && (
                  <>
                    <Dropdown.Separator />
                    <Dropdown.Item id="copy-for-ai" icon={Copy01} label={m.av_menu_copy_for_ai()} />
                    <Dropdown.Item
                      id="chatgpt"
                      icon={LinkExternal01}
                      label={m.av_menu_open_chatgpt()}
                    />
                    <Dropdown.Item
                      id="claude"
                      icon={LinkExternal01}
                      label={m.av_menu_open_claude()}
                    />
                  </>
                )}
                <Dropdown.Separator />
                <Dropdown.Item id="report" icon={Flag01} label={m.ap_report()} />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        </div>
      </header>

      {!signedIn && phonePromptOpen && (
        <div className="shrink-0 border-b border-secondary bg-secondary px-4 py-3 text-sm text-primary sm:hidden">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 pt-0.5">{m.ap_visitor_prompt()}</p>
            <ButtonUtility
              icon={XClose}
              size="xs"
              color="tertiary"
              tooltip={m.ap_dismiss_banner()}
              onClick={dismissPhonePrompt}
            />
          </div>
          <div className="mt-2.5">
            <Button size="sm" color="secondary" onPress={openSignIn}>
              {m.ap_sign_up_or_in()}
            </Button>
          </div>
        </div>
      )}

      <iframe
        aria-label={title}
        src={artifact.url}
        allow="clipboard-read 'none'; clipboard-write 'none'"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-primary"
      />

      {reporting && (
        <PublicArtifactReportDialog
          artifactId={artifact.artifactId}
          onClose={() => setReporting(false)}
        />
      )}
    </main>
  );
}
