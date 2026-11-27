import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { formatDateForDisplay } from "#src/lib/dates";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { getLocale } from "#src/paraglide/runtime";
import {
  addPlatformOperator,
  loadPlatformOperators,
  removePlatformOperator,
  type PlatformOperatorProblem,
} from "./platform-operators.functions";
import type { PlatformOperatorRow } from "#src/server/app-marketplace/platform-operators.server";

const operatorsQueryKey = ["platform-operators"] as const;

function isEntryProblem(problem: PlatformOperatorProblem): boolean {
  return problem === "invalid_address" || problem === "no_user" || problem === "ambiguous";
}

export function ReviewersSection() {
  const queryClient = useQueryClient();
  const load = useServerFn(loadPlatformOperators);
  const add = useServerFn(addPlatformOperator);
  const remove = useServerFn(removePlatformOperator);
  const operators = useQuery({
    queryKey: operatorsQueryKey,
    queryFn: () => load(),
  });
  const formRef = useRef<HTMLFormElement>(null);
  const [formError, setFormError] = useState("");
  const rows = operators.data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: operatorsQueryKey });

  const adding = useMutation({
    mutationFn: (value: string) => add({ data: { entry: value } }),
  });
  const removing = useMutation({
    mutationFn: (userId: string) => remove({ data: { userId } }),
    onSuccess: (result) => {
      setFormError(result.ok ? "" : problemText(result.problem));
      void invalidate();
    },
    onError: () => setFormError(problemText("failed")),
  });

  const form = useAppForm({
    defaultValues: { entry: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const trimmed = value.entry.trim();
      if (!trimmed) return;
      setFormError("");
      try {
        const result = await adding.mutateAsync(trimmed);
        void invalidate();
        if (result.ok) {
          form.reset();
        } else if (isEntryProblem(result.problem)) {
          setFieldServerError(form, "entry", problemText(result.problem), formRef.current);
        } else {
          setFormError(problemText(result.problem));
        }
      } catch {
        setFormError(problemText("failed"));
      }
    },
  });

  return (
    <section
      aria-labelledby="app-reviewers-title"
      className="grid gap-3 border-t border-secondary pt-6"
    >
      <h2 id="app-reviewers-title" className="text-md font-semibold text-primary">
        {m.apps_review_reviewers_title()}
      </h2>
      {operators.isPending ? (
        <div role="status" aria-label={m.empty_reviewers_loading()} className="grid gap-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : operators.isError && !operators.data ? (
        <EmptyState
          size="row"
          role="alert"
          title={m.empty_reviewers_load_failed()}
          primaryAction={
            <RetryButton
              size="row"
              isRetrying={operators.isRefetching}
              onPress={() => void operators.refetch()}
            />
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState size="row" title={m.empty_reviewers_none()} />
      ) : (
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
      )}
      <form.AppForm>
        <form
          ref={formRef}
          noValidate
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <div className="flex items-start gap-2">
            <form.AppField
              name="entry"
              validators={{
                onSubmit: ({ value }) =>
                  value.trim() ? undefined : m.apps_review_reviewers_invalid(),
              }}
            >
              {(field) => (
                <field.Input
                  aria-label={m.apps_review_reviewers_placeholder()}
                  placeholder={m.apps_review_reviewers_placeholder()}
                  isDisabled={adding.isPending}
                  className="max-w-sm"
                  onChange={() => setFormError("")}
                />
              )}
            </form.AppField>
            <Button type="submit" color="secondary" size="md" isDisabled={adding.isPending}>
              {m.apps_review_reviewers_add()}
            </Button>
          </div>
          <form.Alert error={formError} />
        </form>
      </form.AppForm>
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
  const verified = row.email ? row.emailVerified : row.phoneVerified;
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
      onPress={onRemove}
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
