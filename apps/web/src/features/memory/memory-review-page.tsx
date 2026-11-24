import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import * as m from "#src/paraglide/messages";
import { MemoryScopeLinks } from "./memory-scope-links";
import type { TeamMemoryEvidence } from "@lrm/coforge-sdk/agent";
import { MemoryProvenance, MemorySnapshot } from "./memory-provenance";
import { memoryError } from "./memory-copy";
import { memorySuggestionCommand } from "./memory-suggestions.functions";

type Response = Awaited<ReturnType<typeof memorySuggestionCommand>>;
type Draft = { title: string; content: string; source?: string; evidence?: TeamMemoryEvidence[] };
type Suggestion = Extract<Response, { kind: "list" }>["rows"][number];
const memoryList = { q: "", archived: false, offset: 0 };

function suggestionTitle(row: Suggestion) {
  if (row.kind === "duplicate") return m.memory_review_duplicate();
  return (row.payload as Draft).title;
}

export function MemoryReviewPage({ suggestions }: { suggestions: Response }) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: Draft }>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const scan = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await memorySuggestionCommand({ data: { operation: "scan" } });
      if (result.kind === "error") setError(memoryError(result.error));
      if (result.kind === "scan")
        setNotice(
          m.memory_review_scan_result({ inspected: result.inspected, suggested: result.suggested }),
        );
      await router.invalidate({ sync: true });
    } catch {
      setError(m.memory_review_failed());
    } finally {
      setBusy(false);
    }
  };
  const decide = async (row: Suggestion, operation: "accept" | "dismiss" | "verify") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const edit = editing?.id === row.id ? editing.draft : undefined;
      const result = await memorySuggestionCommand({
        data: {
          operation,
          id: row.id,
          ...(operation === "accept" && edit
            ? { edit: { title: edit.title, content: edit.content } }
            : {}),
        },
      });
      if (result.kind === "error") {
        setError(memoryError(result.error));
        return;
      }
      if (result.kind === "decision")
        setNotice(
          result.status === "stale"
            ? m.memory_review_stale()
            : result.status === "accepted"
              ? m.memory_review_published()
              : result.status === "verification"
                ? m.memory_review_verified_later()
                : m.memory_review_dismissed(),
        );
      setEditing(undefined);
      await router.invalidate({ sync: true });
    } catch {
      setError(m.memory_review_failed());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-primary">
      <MemoryScopeLinks
        review
        actions={
          <Button
            size="sm"
            className="min-h-11"
            color="secondary"
            isDisabled={busy || suggestions.kind !== "list"}
            onPress={scan}
          >
            {m.memory_review_scan()}
          </Button>
        }
      />
      <section
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8"
        aria-label={m.memory_review_tab()}
      >
        {notice && (
          <p role="status" className="mb-4 text-sm text-secondary">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-4 text-sm text-error-primary">
            {error}
          </p>
        )}
        {suggestions.kind === "error" && (
          <EmptyState
            size="page"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} />}
            title={m.empty_memory_load_failed_title()}
            description={memoryError(suggestions.error)}
            primaryAction={
              <RetryButton size="page" onPress={() => void router.invalidate({ sync: true })} />
            }
          />
        )}
        {suggestions.kind === "list" && (
          <div className="flex max-w-3xl flex-col gap-4">
            {!suggestions.rows.length && (
              <EmptyState
                size="page"
                picture={<EmptyIcon icon={CheckCircle} muted />}
                title={m.empty_memory_review_caught_up_title()}
                description={m.empty_memory_review_caught_up_description()}
              />
            )}
            {suggestions.rows.map((row) => {
              const draft =
                row.kind === "task" || row.kind === "draft" ? (row.payload as Draft) : undefined;
              const edit = editing?.id === row.id ? editing.draft : undefined;
              return (
                <article key={row.id} className="min-w-0 rounded-xl border border-secondary p-4">
                  <h2 className="wrap-anywhere text-md font-semibold text-primary">
                    {suggestionTitle(row)}
                  </h2>
                  {row.projectName && (
                    <p className="mt-1 wrap-anywhere text-sm text-tertiary">{row.projectName}</p>
                  )}
                  {row.status === "verification" && (
                    <p className="mt-1 text-sm text-secondary">{m.memory_review_verify()}</p>
                  )}
                  {row.blocked && (
                    <p className="mt-1 text-sm text-error-primary">{m.memory_review_stale()}</p>
                  )}
                  {row.snapshots.length > 0 && (
                    <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      {row.snapshots.map((entry, index) => (
                        <MemorySnapshot
                          key={entry.id}
                          entry={entry}
                          links={suggestions.evidenceLinks}
                          label={
                            row.kind === "duplicate"
                              ? index === 0
                                ? m.memory_review_keep_source()
                                : m.memory_review_duplicate_source()
                              : row.kind === "evidence"
                                ? m.memory_review_withdrawn()
                                : m.memory_review_before()
                          }
                        />
                      ))}
                    </div>
                  )}
                  {draft && row.snapshots.length > 0 && (
                    <h3 className="mt-3 text-sm font-medium text-secondary">
                      {m.memory_review_after()}
                    </h3>
                  )}
                  {edit ? (
                    <div className="mt-3 flex flex-col gap-3">
                      <Input
                        label={m.memory_name()}
                        value={edit.title}
                        maxLength={200}
                        onChange={(title) => setEditing({ id: row.id, draft: { ...edit, title } })}
                      />
                      <TextArea
                        label={m.memory_content()}
                        value={edit.content}
                        maxLength={16_000}
                        onChange={(content) =>
                          setEditing({ id: row.id, draft: { ...edit, content } })
                        }
                      />
                    </div>
                  ) : (
                    draft && (
                      <p className="mt-2 wrap-anywhere whitespace-pre-wrap text-sm text-primary">
                        {draft.content}
                      </p>
                    )
                  )}
                  {draft?.source && (
                    <p className="mt-2 wrap-anywhere text-sm text-tertiary">{draft.source}</p>
                  )}
                  {draft?.evidence?.length ? (
                    <div className="mt-2">
                      <MemoryProvenance
                        entry={{ evidence: draft.evidence }}
                        links={suggestions.evidenceLinks}
                      />
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      size="md"
                      className="min-h-11"
                      isDisabled={
                        busy ||
                        row.blocked ||
                        (!!edit && (!edit.title.trim() || !edit.content.trim()))
                      }
                      onPress={() => decide(row, "accept")}
                    >
                      {row.kind === "evidence"
                        ? m.memory_review_reconfirm()
                        : m.memory_review_accept()}
                    </Button>
                    {draft && (
                      <Button
                        size="md"
                        className="min-h-11"
                        color="secondary"
                        isDisabled={busy}
                        onPress={() => setEditing(edit ? undefined : { id: row.id, draft })}
                      >
                        {edit ? m.memory_cancel() : m.memory_review_edit()}
                      </Button>
                    )}
                    <Button
                      size="md"
                      className="min-h-11"
                      color="secondary"
                      isDisabled={busy || row.status === "verification"}
                      onPress={() => decide(row, "verify")}
                    >
                      {m.memory_review_verify()}
                    </Button>
                    <Button
                      size="md"
                      className="min-h-11"
                      color="secondary"
                      isDisabled={busy}
                      onPress={() => decide(row, "dismiss")}
                    >
                      {m.memory_review_dismiss()}
                    </Button>
                  </div>
                </article>
              );
            })}
            {suggestions.next && (
              <Link
                to="/w/$workspaceSlug/settings/memory"
                params={{ workspaceSlug }}
                search={{ ...memoryList, review: true, after: suggestions.next }}
                className="self-start text-sm text-secondary underline underline-offset-4"
              >
                {m.memory_review_next()}
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
