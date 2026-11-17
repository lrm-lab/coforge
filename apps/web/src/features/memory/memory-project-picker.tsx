import { useEffect, useRef, useState } from "react";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import * as m from "#src/paraglide/messages";
import { nameToSlug } from "#src/lib/slug";
import { memoryCommand } from "./memory.functions";
import { memoryError } from "./memory-copy";

type Project = { id: string; name: string; slug: string; description: string };
export function MemoryProjectPicker({
  value,
  onChange,
  selectedName,
  disabled = false,
  allowCreate = false,
  emptyLabel,
  onCreatingChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  selectedName?: string;
  disabled?: boolean;
  allowCreate?: boolean;
  emptyLabel?: string;
  onCreatingChange?: (pending: boolean) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [createPending, setCreatePending] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Project[]>([]);
  const [next, setNext] = useState<number>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  useEffect(() => {
    let stale = false;
    setLoading(true);
    const timer = setTimeout(() => {
      memoryCommand({ data: { operation: "projects", query, offset } })
        .then((result) => {
          if (stale) return;
          if (result.kind === "error") setError(memoryError(result.error));
          else {
            setItems(result.result.projects ?? []);
            setNext(result.result.nextOffset);
            setError("");
          }
        })
        .catch(() => {
          if (!stale) setError(m.memory_failed());
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, offset]);
  return (
    <div className="flex flex-col gap-3">
      <Input
        label={m.memory_project_search()}
        value={query}
        onChange={(value) => {
          setQuery(value);
          setOffset(0);
        }}
        isDisabled={disabled}
      />
      <Select
        label={m.memory_project()}
        selectedKey={value ?? "none"}
        isDisabled={disabled || loading}
        onSelectionChange={(key) => {
          if (key) onChange(key === "none" ? null : String(key));
        }}
      >
        <Select.Item id="none" label={emptyLabel ?? m.memory_no_project()} />
        {value && !items.some((item) => item.id === value) && (
          <Select.Item id={value} label={selectedName || m.memory_project()} />
        )}
        {items.map((item) => (
          <Select.Item key={item.id} id={item.id} label={item.name} />
        ))}
      </Select>
      <div className="flex gap-2">
        {offset > 0 && (
          <Button
            color="secondary"
            size="sm"
            isDisabled={loading || disabled}
            onPress={() => setOffset(Math.max(0, offset - 20))}
          >
            {m.memory_previous()}
          </Button>
        )}
        {next !== undefined && (
          <Button
            color="secondary"
            size="sm"
            isDisabled={loading || disabled}
            onPress={() => setOffset(next)}
          >
            {m.memory_next()}
          </Button>
        )}
        {allowCreate && (
          <Button
            color="link-gray"
            size="sm"
            isDisabled={disabled}
            onPress={() => setCreating(!creating)}
          >
            {m.memory_project_new()}
          </Button>
        )}
      </div>
      {creating && (
        <div className="flex flex-col gap-3 border-t border-secondary pt-3">
          <Input
            label={m.memory_project_name()}
            value={name}
            onChange={(value) => {
              setName(value);
              setSlug(nameToSlug(value, 100));
            }}
            isRequired
            maxLength={100}
          />
          <Input
            label={m.memory_project_slug()}
            value={slug}
            onChange={setSlug}
            isRequired
            maxLength={100}
          />
          <Button
            color="secondary"
            size="sm"
            isDisabled={
              disabled || createPending || !name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
            }
            isLoading={loading}
            onPress={async () => {
              setCreatePending(true);
              onCreatingChange?.(true);
              setLoading(true);
              try {
                const result = await memoryCommand({
                  data: { operation: "project-create", name: name.trim(), slug, description: "" },
                });
                if (!mounted.current) return;
                if (result.kind === "error") setError(memoryError(result.error));
                else {
                  const project = result.result.projects?.[0];
                  if (project) {
                    setItems((items) => [
                      project,
                      ...items.filter((item) => item.id !== project.id),
                    ]);
                    onChange(project.id);
                    setCreating(false);
                    setError("");
                  }
                }
              } catch {
                if (mounted.current) setError(m.memory_failed());
              } finally {
                onCreatingChange?.(false);
                if (mounted.current) {
                  setCreatePending(false);
                  setLoading(false);
                }
              }
            }}
          >
            {m.memory_project_new()}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}
