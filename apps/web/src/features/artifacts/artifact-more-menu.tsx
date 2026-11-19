import {
  Bell01,
  BellOff01,
  ClockRewind,
  Code01,
  Copy01,
  DotsHorizontal,
  Download01,
  Edit03,
  Link01,
  LinkExternal01,
  SearchLg,
  Send01,
  Stars01,
  Trash01,
  Users01,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { VersionMenu } from "./artifact-version-menu";
import { VisibilityMenu, type ArtifactVisibility } from "./use-artifact-visibility";

export type MoreAction =
  | "find"
  | "copy-link"
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
  phone,
  fileCount,
  canDelete,
  canFind,
  following,
  visibility,
  onChooseVersion,
  onAction,
}: {
  artifactId: string;
  shownVersion: number;
  phone: boolean;
  fileCount: number;
  canDelete: boolean;
  canFind: boolean;
  following: boolean;
  visibility: ArtifactVisibility;
  onChooseVersion: (version: number) => void;
  onAction: (action: MoreAction) => void;
}) {
  return (
    <Dropdown.Root>
      <ButtonUtility icon={DotsHorizontal} size="xs" color="tertiary" tooltip={m.doc_more()} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={m.doc_more()} onAction={(key) => onAction(key as MoreAction)}>
          {phone && canFind && (
            <Dropdown.Item id="find" icon={SearchLg} label={m.doc_page_find()} />
          )}
          {phone && <Dropdown.Item id="copy-link" icon={Link01} label={m.doc_copy_link()} />}
          {visibility.linkAvailable && (
            <Dropdown.Item id="embed" icon={Code01} label={m.av_menu_embed()} />
          )}
          <Dropdown.Item id="send" icon={Send01} label={m.doc_send_action()} />
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="ai" icon={Stars01} label={m.av_menu_ai()} />
            <Dropdown.SubmenuPopover className="w-52">
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
          {visibility.canChange && (
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item id="who" icon={Users01} label={m.av_who_can_see()} />
              <Dropdown.SubmenuPopover className="w-64">
                <VisibilityMenu visibility={visibility} />
              </Dropdown.SubmenuPopover>
            </Dropdown.SubmenuTrigger>
          )}
          <Dropdown.Separator />
          {visibility.canChange && (
            <Dropdown.Item id="rename" icon={Edit03} label={m.av_menu_rename()} />
          )}
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="versions" icon={ClockRewind} label={m.av_versions()} />
            <Dropdown.SubmenuPopover className="w-72">
              <VersionMenu
                artifactId={artifactId}
                shown={shownVersion}
                onChoose={onChooseVersion}
              />
            </Dropdown.SubmenuPopover>
          </Dropdown.SubmenuTrigger>
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
