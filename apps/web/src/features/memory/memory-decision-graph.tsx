import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import * as m from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { TeamMemoryDecisionGraph } from "#src/server/db/repositories/team-memory-decision-graph.server";
import { memoryGraphLayout, memoryGraphLine } from "./memory-graph-layout";

type Node = TeamMemoryDecisionGraph["nodes"][number];
type Edge = TeamMemoryDecisionGraph["edges"][number];

function nodeTitle(node: Node) {
  if (node.type === "memory" || node.title) return node.title;
  if (node.kind === "task" && node.taskNumber !== undefined)
    return m.memory_graph_task({ number: node.taskNumber });
  return node.kind === "artifact" ? m.memory_graph_artifact() : m.memory_graph_message();
}

function relationLabel(edge: Edge, selected: Node, other: Node) {
  if (edge.kind === "conflicts_with") return m.memory_graph_conflicts();
  const out = edge.from === selected.key;
  if (edge.kind === "supports")
    return out ? m.memory_graph_supports() : m.memory_graph_supported_by();
  if (edge.kind === "revision")
    return out ? m.memory_graph_next_version() : m.memory_graph_previous_version();
  if (out && other.type === "memory") {
    if (other.scheduled) return m.memory_graph_scheduled_replacement();
    if (other.archived) return m.memory_graph_archived_replacement();
    if (selected.type === "memory" && selected.current)
      return m.memory_graph_historical_replacement();
  }
  return out ? m.memory_graph_replaced_by() : m.memory_graph_replaces();
}

function GraphNodeLink({ node }: { node: Node }) {
  const workspaceSlug = useWorkspaceSlug();
  const className = "shrink-0 text-sm text-secondary underline underline-offset-4";
  if (node.type === "memory")
    return (
      <Link
        to="/w/$workspaceSlug/memory"
        params={{ workspaceSlug }}
        search={{ q: "", offset: 0, archived: false, id: node.id, revision: node.revision }}
        className={className}
      >
        {m.memory_graph_open_version()}
      </Link>
    );
  if (node.kind === "artifact")
    return (
      <Link
        to="/w/$workspaceSlug/artifacts/$artifactId"
        params={{ workspaceSlug, artifactId: node.id }}
        search={{ version: node.revision }}
        className={className}
      >
        {m.memory_graph_open_evidence()}
      </Link>
    );
  if (!node.conversationId) return null;
  return (
    <Link
      to="/w/$workspaceSlug/channel/$channelId"
      params={{ workspaceSlug, channelId: node.conversationId }}
      search={node.kind === "task" ? { task: node.taskNumber } : { message: node.id }}
      className={className}
    >
      {m.memory_graph_open_evidence()}
    </Link>
  );
}

function GraphSelection({ node, graph }: { node: Node; graph: TeamMemoryDecisionGraph }) {
  const relations = graph.edges
    .filter((edge) => edge.from === node.key || edge.to === node.key)
    .map((edge) => {
      const other = graph.nodes.find(
        ({ key }) => key === (edge.from === node.key ? edge.to : edge.from),
      );
      return { edge, other };
    });
  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-t border-secondary px-4 py-3"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="min-w-0 grow wrap-anywhere text-sm font-medium text-primary">
          {nodeTitle(node)}
          {node.revision !== undefined && (
            <span className="ms-2 text-xs font-normal text-tertiary">
              {m.memory_revision({ revision: node.revision })}
              {node.type === "memory" &&
                (node.current
                  ? ` · ${m.memory_graph_current()}`
                  : node.scheduled
                    ? ` · ${m.memory_graph_scheduled()}`
                    : node.archived
                      ? ` · ${m.memory_graph_archived()}`
                      : "")}
            </span>
          )}
        </p>
        <GraphNodeLink node={node} />
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary">
        {relations.map(
          ({ edge, other }) =>
            other && (
              <li key={`${edge.kind}:${edge.from}:${edge.to}`} className="min-w-0 wrap-anywhere">
                <span>{relationLabel(edge, node, other)}</span> <span>{nodeTitle(other)}</span>
              </li>
            ),
        )}
      </ul>
    </div>
  );
}

function DecisionGraph({ graph }: { graph: TeamMemoryDecisionGraph }) {
  const marker = useId();
  const heading = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState(graph.root);
  const measure = useCallback(() => {
    const frame = plot.current?.getBoundingClientRect();
    if (frame) setSize({ width: frame.width, height: frame.height });
  }, []);
  useEffect(measure, [measure]);
  useResizeObserver({ ref: plot, onResize: measure });
  const positions = memoryGraphLayout(graph);
  const node = graph.nodes.find(({ key }) => key === selected) ?? graph.nodes[0]!;

  return (
    <section
      aria-labelledby={heading}
      className="overflow-hidden rounded-lg border border-secondary"
    >
      <h3
        id={heading}
        className="border-b border-secondary px-4 py-3 text-sm font-semibold text-primary"
      >
        {m.memory_graph_title()}
      </h3>
      <div ref={plot} className="relative h-[18rem] bg-secondary sm:h-[20rem]">
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
          <defs>
            <marker
              id={marker}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path
                d="M1 1L7 4L1 7"
                fill="none"
                stroke="context-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const related = edge.from === node.key || edge.to === node.key;
            const directed = edge.kind === "supersedes" || edge.kind === "revision";
            const line = memoryGraphLine(
              from,
              to,
              size.width,
              size.height,
              edge.from === node.key ? 12 : 8,
              (edge.to === node.key ? 12 : 8) + (directed ? 3 : 0),
            );
            return (
              line && (
                <line
                  key={`${edge.kind}:${edge.from}:${edge.to}`}
                  {...line}
                  stroke="currentColor"
                  strokeWidth={related ? 1.6 : 1.2}
                  className={related ? "text-utility-purple-600" : "text-fg-quaternary opacity-50"}
                  strokeDasharray={edge.kind === "conflicts_with" ? "4 4" : undefined}
                  markerEnd={directed ? `url(#${marker})` : undefined}
                />
              )
            );
          })}
        </svg>
        {graph.nodes.map((item) => {
          const point = positions.get(item.key);
          if (!point) return null;
          const active = item.key === node.key;
          const title = nodeTitle(item);
          const label =
            item.type === "memory"
              ? `${title} (${m.memory_revision({ revision: item.revision })})`
              : title;
          const dotColor =
            item.type === "evidence"
              ? "border-utility-blue-600 bg-utility-blue-200"
              : item.current
                ? "border-utility-green-600 bg-utility-green-200"
                : "border-utility-purple-600 bg-utility-purple-200";
          return (
            <div
              key={item.key}
              className={`absolute flex w-[26%] -translate-x-1/2 -translate-y-[1.375rem] flex-col items-center ${active ? "z-10" : ""}`}
              style={{ left: `${point[0] * 100}%`, top: `${point[1] * 100}%` }}
            >
              <Button
                color="tertiary"
                size="sm"
                noTextPadding
                className="size-11 shrink-0 rounded-full p-0 hover:bg-transparent"
                aria-label={label}
                aria-pressed={active}
                onPress={() => setSelected(item.key)}
              >
                <span
                  aria-hidden="true"
                  className={`block rounded-full border-2 ${dotColor} ${active ? "size-5 ring-4 ring-utility-purple-100" : "size-3"}`}
                />
              </Button>
              <span
                aria-hidden="true"
                className={`w-full truncate text-center text-xs ${active ? "font-semibold text-primary" : "text-tertiary"}`}
              >
                {title}
              </span>
            </div>
          );
        })}
      </div>
      <GraphSelection node={node} graph={graph} />
    </section>
  );
}

export function MemoryDecisionGraph({ graph }: { graph?: TeamMemoryDecisionGraph }) {
  if (!graph || graph.edges.length === 0) return null;
  return <DecisionGraph key={graph.root} graph={graph} />;
}
