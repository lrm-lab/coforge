import { SubmenuTrigger } from "react-aria-components";
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
  SearchLg,
  Send01,
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
      <ButtonUtility icon={DotsHorizontal} size="sm" color="tertiary" tooltip={m.doc_more()} />
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
          {visibility.canChange && (
            <SubmenuTrigger>
              <Dropdown.Item id="who" icon={Users01} label={m.av_who_can_see()} />
              <Dropdown.SubmenuPopover className="w-64">
                <VisibilityMenu visibility={visibility} />
              </Dropdown.SubmenuPopover>
            </SubmenuTrigger>
          )}
          <Dropdown.Separator />
          {visibility.canChange && (
            <Dropdown.Item id="rename" icon={Edit03} label={m.av_menu_rename()} />
          )}
          <SubmenuTrigger>
            <Dropdown.Item id="versions" icon={ClockRewind} label={m.av_versions()} />
            <Dropdown.SubmenuPopover className="w-72">
              <VersionMenu
                artifactId={artifactId}
                shown={shownVersion}
                onChoose={onChooseVersion}
              />
            </Dropdown.SubmenuPopover>
          </SubmenuTrigger>
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
