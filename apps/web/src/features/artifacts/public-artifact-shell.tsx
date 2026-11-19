import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Copy01, Flag01, GitBranch01, Link01, LinkExternal01, Stars01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { buildAiPromptUrl, formatArtifactForAi, type AiProvider } from "./artifact-ai-shortcuts";
import { publicArtifactPath } from "./artifact-short-id";
import { PublicArtifactForkDialog, PublicArtifactReportDialog } from "./public-artifact-dialogs";

export type PublicArtifactData = {
  artifactId: string;
  title: string;
  url: string;
  version: number;
};

export function PublicArtifactShell({
  artifact,
  rateLimited = false,
}: {
  artifact: PublicArtifactData | null;
  rateLimited?: boolean;
}) {
  const toast = useAppToast();
  const [forking, setForking] = useState(false);
  const [reporting, setReporting] = useState(false);

  if (!artifact) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-primary px-6 text-center">
        <h1 className="text-lg font-semibold text-primary">{m.ap_unavailable_title()}</h1>
        <p className="mt-2 max-w-md text-sm text-secondary">
          {rateLimited ? m.ap_rate_limited() : m.ap_unavailable_body()}
        </p>
        <Link to="/" className="mt-5 text-sm font-medium text-brand-secondary hover:underline">
          {m.ap_open_in_coforge()}
        </Link>
      </div>
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

  const onAiAction = async (action: "copy-for-ai" | AiProvider) => {
    const context = { title, version: artifact.version, url: shareUrl };
    if (action === "copy-for-ai") {
      if (await copyText(formatArtifactForAi(context))) toast.success(m.av_ai_copied());
      else toast.error(m.conversation_copy_failed());
      return;
    }
    window.open(buildAiPromptUrl(action, context), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex h-dvh flex-col bg-primary">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-secondary bg-primary px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            to="/"
            className="shrink-0 text-sm font-semibold tracking-tight text-primary hover:text-brand-secondary"
          >
            CoForge
          </Link>
          <span aria-hidden="true" className="text-quaternary">
            /
          </span>
          <h1 className="truncate text-sm font-medium text-primary">{title}</h1>
          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary">
            v{artifact.version}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <ButtonUtility
            icon={Link01}
            size="xs"
            color="tertiary"
            tooltip={m.doc_copy_link()}
            onClick={() => void copyLink()}
          />
          <Dropdown.Root>
            <ButtonUtility icon={Stars01} size="xs" color="tertiary" tooltip={m.av_menu_ai()} />
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={m.av_menu_ai()}
                onAction={(key) => void onAiAction(key as "copy-for-ai" | AiProvider)}
              >
                <Dropdown.Item id="copy-for-ai" icon={Copy01} label={m.av_menu_copy_for_ai()} />
                <Dropdown.Item
                  id="chatgpt"
                  icon={LinkExternal01}
                  label={m.av_menu_open_chatgpt()}
                />
                <Dropdown.Item id="claude" icon={LinkExternal01} label={m.av_menu_open_claude()} />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <Button
            size="sm"
            color="secondary"
            iconLeading={GitBranch01}
            onPress={() => setForking(true)}
          >
            <span className="hidden sm:inline">{m.ap_fork()}</span>
          </Button>
          <ButtonUtility
            icon={Flag01}
            size="xs"
            color="tertiary"
            tooltip={m.ap_report()}
            onClick={() => setReporting(true)}
          />
        </div>
      </header>

      <iframe
        aria-label={title}
        src={artifact.url}
        allow="clipboard-read 'none'; clipboard-write 'none'"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-primary"
      />

      {forking && (
        <PublicArtifactForkDialog title={title} url={shareUrl} onClose={() => setForking(false)} />
      )}
      {reporting && (
        <PublicArtifactReportDialog
          artifactId={artifact.artifactId}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
}
