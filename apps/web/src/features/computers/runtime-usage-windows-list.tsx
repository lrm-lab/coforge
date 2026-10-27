import { useId, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import type { UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";
import {
  officialBucketDetail,
  officialBucketLabel,
  usageWindowLabel,
} from "./runtime-usage-windows";
import { UsageWindow } from "./usage-window";

/**
 * The runtime popover's usage rows: the provider's official groups with their notes behind a
 * button when it reports them, otherwise its primary and secondary windows.
 */
export function RuntimeUsageWindows({
  provider,
  snapshot,
  timeZone,
}: {
  provider: RuntimeProvider;
  snapshot: UsageSnapshot | undefined;
  timeZone: string | null;
}) {
  const notesId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const windows = snapshot
    ? (["primary", "secondary"] as const).flatMap((key) => {
        const window = snapshot[key];
        return window ? [{ key, window }] : [];
      })
    : [];
  const hasUsageNotes = Boolean(
    snapshot?.officialDescription || snapshot?.officialGroups?.some((group) => group.description),
  );

  return snapshot?.officialGroups && snapshot.officialGroups.length > 0 ? (
    // Rows read "group · window", as on Raft, then the used share and reset. The
    // provider's notes stay on the snapshot and open from this button: a tooltip
    // inside the peek would close it (task #258). Per-bucket sentences are not
    // painted; they repeat the reset already on the row.
    <div className="mt-3 space-y-4">
      {snapshot.officialGroups.map((group, index) => (
        <div key={`${group.name ?? "group"}-${index}`} className="space-y-3">
          {group.buckets.map((bucket, bucketIndex) => {
            const detail = officialBucketDetail(bucket);
            const rowLabel = officialBucketLabel(bucket);
            return (
              <UsageWindow
                key={bucket.id ?? `${bucket.window ?? "bucket"}-${bucketIndex}`}
                label={
                  group.name && group.name !== rowLabel ? `${group.name} · ${rowLabel}` : rowLabel
                }
                window={{
                  ...(bucket.usedPercent !== undefined ? { usedPercent: bucket.usedPercent } : {}),
                  ...(bucket.status ? { status: bucket.status } : {}),
                  ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
                }}
                detail={detail}
                note={detail ? undefined : bucket.description}
                creditUsage={bucket.window === "credit" ? snapshot.creditUsage : undefined}
                timeZone={timeZone}
                showLeft
              />
            );
          })}
        </div>
      ))}
      {hasUsageNotes && (
        <div>
          <Button
            size="sm"
            color="link-gray"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onPress={() => setNotesOpen((open) => !open)}
          >
            {notesOpen ? m.computer_usage_hide_notes() : m.computer_usage_notes()}
          </Button>
          {notesOpen && (
            <div id={notesId} className="mt-2 space-y-2">
              {snapshot.officialDescription && (
                <p className="text-xs break-words text-tertiary">{snapshot.officialDescription}</p>
              )}
              {snapshot.officialGroups.map((group, index) =>
                group.description ? (
                  <p
                    key={`${group.name ?? "note"}-${index}`}
                    className="text-xs break-words text-tertiary"
                  >
                    {group.name && (
                      <span className="font-medium text-secondary">{group.name}. </span>
                    )}
                    {group.description}
                  </p>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  ) : (
    windows.length > 0 && (
      <div className="mt-3 space-y-3">
        {windows.map(({ key, window }) => (
          <UsageWindow
            key={key}
            label={usageWindowLabel(provider, key, window)}
            window={window}
            creditUsage={key === "primary" ? snapshot?.creditUsage : undefined}
            timeZone={timeZone}
            showLeft
          />
        ))}
      </div>
    )
  );
}
