import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { m } from "#src/paraglide/messages";
import { formatDateForDisplay } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";
import {
  addPlatformOperator,
  loadPlatformOperators,
  removePlatformOperator,
  type PlatformOperatorProblem,
} from "./platform-operators.functions";
import type { PlatformOperatorRow } from "#src/server/app-marketplace/platform-operators.server";

const operatorsQueryKey = ["platform-operators"] as const;

/**
 * Who reviews Marketplace apps, for the review page: the operators themselves, an operator's
 * removal, and adding one by a verified email or phone number. The last operator's remove button is
 * disabled, with the reason on its tooltip: an empty list could never be refilled from here.
 */
export function ReviewersSection() {
  const queryClient = useQueryClient();
  const load = useServerFn(loadPlatformOperators);
  const add = useServerFn(addPlatformOperator);
  const remove = useServerFn(removePlatformOperator);
  const operators = useQuery({
    queryKey: operatorsQueryKey,
    queryFn: () => load(),
  });
  const [entry, setEntry] = useState("");
  const [problem, setProblem] = useState<PlatformOperatorProblem | null>(null);
  const rows = operators.data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: operatorsQueryKey });

  const adding = useMutation({
    mutationFn: (value: string) => add({ data: { entry: value } }),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      if (result.ok) setEntry("");
      void invalidate();
    },
    onError: () => setProblem("failed"),
  });
  const removing = useMutation({
    mutationFn: (userId: string) => remove({ data: { userId } }),
    onSuccess: (result) => {
      setProblem(result.ok ? null : result.problem);
      void invalidate();
    },
    onError: () => setProblem("failed"),
  });

  return (
    <section
      aria-labelledby="app-reviewers-title"
      className="grid gap-3 border-t border-secondary pt-6"
    >
      <h2 id="app-reviewers-title" className="text-md font-semibold text-primary">
        {m.apps_review_reviewers_title()}
      </h2>
      <ul className="grid gap-2">
        {rows.map((row) => (
          <ReviewerRow
            key={row.userId}
            row={row}
            last={rows.length === 1}
            removing={removing.isPending}
            onRemove={() => removing.mutate(row.userId)}
          />
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!entry.trim()) return;
          adding.mutate(entry.trim());
        }}
      >
        <Input
          aria-label={m.apps_review_reviewers_placeholder()}
          placeholder={m.apps_review_reviewers_placeholder()}
          value={entry}
          onChange={setEntry}
          isDisabled={adding.isPending}
          className="max-w-sm"
        />
        <Button type="submit" color="secondary" size="md" isDisabled={adding.isPending}>
          {m.apps_review_reviewers_add()}
        </Button>
      </form>
      {problem ? (
        <p role="alert" className="text-sm text-error-primary">
          {problemText(problem)}
        </p>
      ) : null}
    </section>
  );
}

function ReviewerRow({
  row,
  last,
  removing,
  onRemove,
}: {
  row: PlatformOperatorRow;
  last: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const address = row.email ?? row.phone ?? "";
  // null is "the provider has not said", which shows no label at all rather than a wrong one.
  const verified = row.email ? row.emailVerified : row.phoneVerified;
  // The last reviewer's control stays on screen but does nothing; its reason is the tooltip, as
  // the page keeps no room for a second line of explanation.
  const removeButton = last ? (
    <Tooltip title={m.apps_review_reviewers_last()} placement="top end">
      <TooltipTrigger
        aria-disabled="true"
        className="flex h-8 shrink-0 cursor-default items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-quaternary outline-focus-ring focus-visible:outline-2"
      >
        <XClose aria-hidden="true" className="size-4" />
        {m.apps_review_reviewers_remove()}
      </TooltipTrigger>
    </Tooltip>
  ) : (
    <Button
      color="tertiary"
      size="sm"
      iconLeading={XClose}
      isDisabled={removing}
      onClick={onRemove}
    >
      {m.apps_review_reviewers_remove()}
    </Button>
  );
  return (
    <li className="flex items-center justify-between gap-4 rounded-lg border border-secondary px-3 py-2">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium text-primary">{row.name}</span>
        <span className="text-sm text-tertiary">
          {address}
          {verified === false ? ` · ${m.apps_review_reviewers_unverified()}` : null}
        </span>
        <span className="text-xs text-quaternary">
          {row.grantedByName
            ? m.apps_review_reviewers_added_by({ name: row.grantedByName })
            : m.apps_review_reviewers_seeded()}
          {` · ${formatDateForDisplay(row.grantedAt, null, getLocale())}`}
        </span>
      </div>
      {removeButton}
    </li>
  );
}

function problemText(problem: PlatformOperatorProblem): string {
  switch (problem) {
    case "invalid_address":
      return m.apps_review_reviewers_invalid();
    case "no_user":
      return m.apps_review_reviewers_no_user();
    case "ambiguous":
      return m.apps_review_reviewers_ambiguous();
    case "last":
      return m.apps_review_reviewers_last();
    default:
      return m.apps_review_reviewers_error();
  }
}
