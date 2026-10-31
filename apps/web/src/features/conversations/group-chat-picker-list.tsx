import { Checkbox as AriaCheckbox } from "react-aria-components";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { filterGroupChatCandidates, type GroupChatCandidate } from "./group-chat-picker";

/** The group chat dialog's member picker: a search and the Workspace's people and public Agents,
 * each a ticked row, in a column its parent sizes. A phone frames the list, as Raft does. */
export function GroupChatPicker({
  candidates,
  search,
  onSearchChange,
  selectedKeys,
  onToggle,
  directory,
  disabled,
  framed = false,
}: {
  candidates: GroupChatCandidate[];
  search: string;
  onSearchChange: (search: string) => void;
  selectedKeys: ReadonlySet<string>;
  onToggle: (key: string, on: boolean) => void;
  directory: { isPending: boolean; isError: boolean; refetch: () => unknown };
  disabled: boolean;
  framed?: boolean;
}) {
  const shown = filterGroupChatCandidates(candidates, search);
  return (
    <>
      <Input
        aria-label={m.channel_members_search_placeholder()}
        placeholder={m.channel_members_search_placeholder()}
        value={search}
        onChange={onSearchChange}
      />
      <div
        className={cx(
          "min-h-0 flex-1 overflow-y-auto",
          framed && "rounded-lg border border-secondary p-1",
        )}
      >
        {directory.isPending && (
          <p className="px-2 py-2 text-sm text-tertiary">{m.channel_members_loading()}</p>
        )}
        {directory.isError && (
          <div className="flex flex-col items-start gap-3 px-2 py-2">
            <p role="alert" className="text-sm text-error-primary">
              {m.channel_members_load_error()}
            </p>
            <Button color="secondary" size="sm" onPress={() => void directory.refetch()}>
              {m.controls_retry()}
            </Button>
          </div>
        )}
        {!directory.isPending && !directory.isError && shown.length === 0 && (
          <p className="px-2 py-2 text-sm text-tertiary">
            {search.trim()
              ? m.channel_members_no_matches({ query: search.trim() })
              : m.channel_members_none()}
          </p>
        )}
        <ul className="flex flex-col">
          {shown.map((entry) => (
            <li key={entry.key}>
              <AriaCheckbox
                isSelected={selectedKeys.has(entry.key)}
                isDisabled={disabled}
                onChange={(on) => onToggle(entry.key, on)}
                aria-label={entry.name}
                // `relative` keeps React Aria's visually hidden input inside the row. Without it the
                // input is placed against the dialog, whose scroll area then grows past the list
                // and scrolls the whole dialog when a lower row is ticked (task #331).
                className="relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-primary_hover disabled:cursor-not-allowed"
              >
                {({ isSelected, isDisabled, isFocusVisible }) => (
                  <>
                    <CheckboxBase
                      isSelected={isSelected}
                      isDisabled={isDisabled}
                      isFocusVisible={isFocusVisible}
                    />
                    <IdentityAvatar
                      size="xs"
                      alt=""
                      src={entry.avatarUrl ?? undefined}
                      name={entry.name}
                    />
                    <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-primary">
                      {entry.name}
                    </span>
                  </>
                )}
              </AriaCheckbox>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
