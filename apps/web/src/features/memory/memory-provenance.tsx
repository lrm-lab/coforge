import { Link } from "@tanstack/react-router";
import type { TeamMemoryHead } from "@lrm/coforge-sdk/agent";
import * as m from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { memoryCommand } from "./memory.functions";
import { memoryError } from "./memory-copy";
import { MemoryScopeLinks } from "./memory-scope-links";

const memoryList = { q: "", archived: false, offset: 0 };

type Provenance = Pick<TeamMemoryHead, "evidence" | "relations" | "effectiveAt">;
export type EvidenceLinks = Record<string, { conversationId: string; taskNumber?: number }>;
type Snapshot = Pick<TeamMemoryHead, "id" | "revision" | "title" | "content" | "source"> &
  Provenance;

export function MemorySnapshot({
  entry,
  label,
  links,
}: {
  entry: Snapshot;
  label: string;
  links?: EvidenceLinks;
}) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <div className="min-w-0 rounded-lg border border-secondary px-3 py-3">
      <Link
        to="/w/$workspaceSlug/memory"
        params={{ workspaceSlug }}
        search={{ ...memoryList, id: entry.id, revision: entry.revision }}
        className="text-sm font-medium text-secondary underline underline-offset-4"
      >
        {label} · {m.memory_revision({ revision: entry.revision })}
      </Link>
      <p className="mt-1 wrap-anywhere text-sm font-medium text-primary">{entry.title}</p>
      <p className="mt-2 wrap-anywhere whitespace-pre-wrap text-sm text-primary">{entry.content}</p>
      <p className="my-2 wrap-anywhere text-sm text-tertiary">{entry.source}</p>
      <MemoryProvenance entry={entry} links={links} />
    </div>
  );
}

export function MemoryVersionPage({
  detail,
}: {
  detail: Awaited<ReturnType<typeof memoryCommand>>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const entry = detail.kind === "ready" ? detail.result.entries[0] : undefined;
  return (
    <main className="flex h-full min-h-0 flex-col bg-primary">
      <header className="border-b border-secondary px-5 py-4 lg:px-8">
        <h1 className="text-lg font-semibold text-primary">{m.memory_title()}</h1>
      </header>
      <MemoryScopeLinks />
      <section className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8">
        {entry ? (
          <div className="flex max-w-3xl flex-col gap-3">
            <h2 className="wrap-anywhere text-md font-semibold text-primary">{entry.title}</h2>
            <p className="text-sm text-secondary">
              {m.memory_revision({ revision: entry.revision })}
            </p>
            <p className="wrap-anywhere whitespace-pre-wrap text-sm text-primary">
              {entry.content}
            </p>
            <p className="wrap-anywhere text-sm text-tertiary">{entry.source}</p>
            <MemoryProvenance
              entry={entry}
              links={detail.kind === "ready" ? detail.evidenceLinks : undefined}
            />
            <Link
              to="/w/$workspaceSlug/memory"
              params={{ workspaceSlug }}
              search={{ ...memoryList, id: entry.id }}
              className="self-start text-sm text-secondary underline underline-offset-4"
            >
              {m.memory_review_current()}
            </Link>
          </div>
        ) : (
          <p role="alert" className="text-sm text-error-primary">
            {detail.kind === "error" ? memoryError(detail.error) : m.memory_failed()}
          </p>
        )}
      </section>
    </main>
  );
}

export function MemoryProvenance({
  entry,
  links = {},
}: {
  entry: Provenance;
  links?: EvidenceLinks;
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (!entry.evidence?.length && !entry.relations?.length && !entry.effectiveAt) return null;
  return (
    <ul className="flex min-w-0 flex-col gap-2 text-sm text-secondary">
      {entry.effectiveAt && <li>{m.memory_review_effective({ date: entry.effectiveAt })}</li>}
      {entry.evidence?.map(({ kind, id, revision }) => {
        const target = links[`${kind}:${id}`];
        const label = m.memory_review_evidence({ kind, id });
        return (
          <li key={`${kind}:${id}:${revision ?? ""}`} className="wrap-anywhere">
            {kind === "artifact" ? (
              <Link
                to="/w/$workspaceSlug/artifacts/$artifactId"
                params={{ workspaceSlug, artifactId: id }}
                search={{ version: revision }}
                className="underline underline-offset-4"
              >
                {label}
              </Link>
            ) : target ? (
              <Link
                to="/w/$workspaceSlug/channel/$channelId"
                params={{ workspaceSlug, channelId: target.conversationId }}
                search={kind === "task" ? { task: target.taskNumber } : { message: id }}
                className="underline underline-offset-4"
              >
                {label}
              </Link>
            ) : (
              label
            )}
            {revision === undefined ? "" : ` · ${m.memory_revision({ revision })}`}
          </li>
        );
      })}
      {entry.relations?.map(({ kind, id, revision }) => (
        <li key={`${kind}:${id}:${revision}`}>
          <Link
            to="/w/$workspaceSlug/memory"
            params={{ workspaceSlug }}
            search={{ ...memoryList, id, revision }}
            className="underline underline-offset-4"
          >
            {kind === "supersedes"
              ? m.memory_review_supersedes({ revision })
              : m.memory_review_conflict({ revision })}
          </Link>
        </li>
      ))}
    </ul>
  );
}
