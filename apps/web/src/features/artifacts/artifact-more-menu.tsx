import {
  Bell01,
  BellOff01,
  ClockRewind,
  Copy01,
  DotsHorizontal,
  Download01,
  Edit03,
  InfoCircle,
  LinkExternal01,
  Monitor02,
  SearchLg,
  Stars01,
  Trash01,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { VersionMenu } from "./artifact-version-menu";
import type { ArtifactVisibility } from "./use-artifact-visibility";

export type MoreAction =
  | "find"
  | "embed"
  | "send"
  | "copy-for-ai"
  | "open-chatgpt"
  | "open-claude"
  | "rename"
  | "files"
  | "download"
  | "follow"
  | "delete";

export function ArtifactMoreMenu({
  artifactId,
  shownVersion,
  hasMultipleVersions,
  phone,
  findShortcut,
  fileCount,
  canDelete,
  canFind,
  following,
  visibility,
  onChooseVersion,
  onOpenDetails,
  onOpenFullPage,
  onDisplayReport,
  onAction,
}: {
  artifactId: string;
  shownVersion: number;
  hasMultipleVersions: boolean;
  phone: boolean;
  findShortcut?: string;
  fileCount: number;
  canDelete: boolean;
  canFind: boolean;
  following: boolean;
  visibility: ArtifactVisibility;
  onChooseVersion: (version: number) => void;
  onOpenDetails?: () => void;
  onOpenFullPage?: () => void;
  onDisplayReport?: () => void;
  onAction: (action: MoreAction) => void;
}) {
  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={DotsHorizontal}
        size="xs"
        color="tertiary"
        tooltip={m.doc_more()}
        className="size-8 any-pointer-coarse:after:-inset-1.5"
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={m.doc_more()}
          onAction={(key) => {
            if (key === "details") onOpenDetails?.();
            else if (key === "open-full-page") onOpenFullPage?.();
            else if (key === "display-report") onDisplayReport?.();
            else onAction(key as MoreAction);
          }}
        >
          {onOpenDetails && (
            <Dropdown.Item id="details" icon={InfoCircle} label={m.av_details_label()} />
          )}
          {canFind && (
            <Dropdown.Item
              id="find"
              icon={SearchLg}
              label={m.doc_page_find()}
              shortcut={findShortcut}
            />
          )}
          {onOpenFullPage && (
            <Dropdown.Item
              id="open-full-page"
              icon={LinkExternal01}
              label={m.av_open_full_page()}
            />
          )}
          <Dropdown.SubmenuTrigger openOnHover={false}>
            <Dropdown.Item id="ai" icon={Stars01} label={m.av_menu_ai()} />
            <Dropdown.SubmenuPopover title={false} className="w-52">
              <Dropdown.Menu
                aria-label={m.av_menu_ai()}
                onAction={(key) => onAction(key as MoreAction)}
              >
                <Dropdown.Item id="copy-for-ai" icon={Copy01} label={m.av_menu_copy_for_ai()} />
                <Dropdown.Item
                  id="open-chatgpt"
                  icon={LinkExternal01}
                  label={m.av_menu_open_chatgpt()}
                />
                <Dropdown.Item
                  id="open-claude"
                  icon={LinkExternal01}
                  label={m.av_menu_open_claude()}
                />
              </Dropdown.Menu>
            </Dropdown.SubmenuPopover>
          </Dropdown.SubmenuTrigger>
          <Dropdown.Separator />
          {visibility.canChange && (
            <Dropdown.Item id="rename" icon={Edit03} label={m.av_menu_rename()} />
          )}
          {phone && hasMultipleVersions && (
            <Dropdown.SubmenuTrigger openOnHover={false}>
              <Dropdown.Item id="versions" icon={ClockRewind} label={m.av_versions()} />
              <Dropdown.SubmenuPopover
                title={false}
                className="[--cascade-menu-max-width:min(21rem,calc(100vw-1.5rem))] [--cascade-menu-width:min(21rem,calc(100vw-1.5rem))]"
              >
                <VersionMenu
                  artifactId={artifactId}
                  shown={shownVersion}
                  onChoose={onChooseVersion}
                />
              </Dropdown.SubmenuPopover>
            </Dropdown.SubmenuTrigger>
          )}
          {onDisplayReport && (
            <Dropdown.Item id="display-report" icon={Monitor02} label={m.av_cm_display_issue()} />
          )}
          <Dropdown.Item id="files" icon={Copy01} label={m.av_menu_files()} />
          <Dropdown.Item
            id="download"
            icon={Download01}
            label={fileCount > 1 ? m.av_menu_download_all() : m.av_menu_download()}
          />
          <Dropdown.Separator />
          <Dropdown.Item
            id="follow"
            icon={following ? BellOff01 : Bell01}
            label={following ? m.av_unfollow() : m.av_follow()}
          />
          {canDelete && <Dropdown.Separator />}
          {canDelete && <Dropdown.Item id="delete" icon={Trash01} label={m.doc_delete()} />}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
