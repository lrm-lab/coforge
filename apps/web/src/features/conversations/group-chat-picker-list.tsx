import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Face } from "#src/features/pickers/entity-picker";
import { PickerListRow } from "#src/features/pickers/picker-list";
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
          "flex min-h-0 flex-1 flex-col",
          framed && "overflow-hidden rounded-lg border border-secondary",
        )}
      >
        <div
          className={cx(
            "scroll-fade-y min-h-0 flex-1 overflow-y-auto scroll-py-6",
            framed && "p-1",
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
              <PickerListRow
                key={entry.key}
                label={entry.name}
                description={entry.description}
                leading={
                  <Face
                    face={{
                      kind: "identity",
                      name: entry.name,
                      src: entry.avatarUrl,
                      ...(entry.kind === "agent" ? { agentId: entry.id } : { userId: entry.id }),
                    }}
                  />
                }
                addon={entry.search.kind === "agent" ? `@${entry.search.name}` : undefined}
                isSelected={selectedKeys.has(entry.key)}
                isDisabled={disabled}
                onChange={(on) => onToggle(entry.key, on)}
              />
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
