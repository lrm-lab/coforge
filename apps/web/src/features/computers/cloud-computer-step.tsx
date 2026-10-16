import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { addExtraCloudComputer, ensureCloudComputer } from "./cloud-computers.functions";

export function CloudComputerStep({
  workspaceSlug,
  onCreated,
  onBack,
}: {
  workspaceSlug: string | null;
  onCreated: (computerId: string) => Promise<void>;
  onBack: () => void;
}) {
  const ensure = useServerFn(ensureCloudComputer);
  const addExtra = useServerFn(addExtraCloudComputer);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<"default" | "extra" | null>(null);
  const busy = useRef(false);

  async function create(slot: "default" | "extra") {
    if (!workspaceSlug || busy.current) return;
    busy.current = true;
    setSaving(slot);
    setError("");
    try {
      const created = slot === "default" ? await ensure() : await addExtra();
      if (!created) {
        setError(m.computer_cloud_unavailable());
        return;
      }
      await onCreated(created.computerId);
    } catch (cause) {
      setError(createErrorMessage(cause));
    } finally {
      busy.current = false;
      setSaving(null);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 px-6 py-6 sm:px-8">
        <p className="text-sm text-tertiary">{m.computer_cloud_host_description()}</p>
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-secondary px-6 py-4 sm:px-8">
        <Button color="secondary" type="button" onPress={onBack} isDisabled={saving !== null}>
          {m.controls_back()}
        </Button>
        <Button
          color="secondary"
          type="button"
          onPress={() => void create("extra")}
          isDisabled={!workspaceSlug || saving !== null}
          isLoading={saving === "extra"}
          showTextWhileLoading
        >
          {saving === "extra" ? m.computer_cloud_creating() : m.computer_cloud_add_extra()}
        </Button>
        <Button
          type="button"
          onPress={() => void create("default")}
          isDisabled={!workspaceSlug || saving !== null}
          isLoading={saving === "default"}
          showTextWhileLoading
        >
          {saving === "default" ? m.computer_cloud_creating() : m.computer_cloud_use()}
        </Button>
      </div>
    </div>
  );
}

function createErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (
    message === "an extra cloud computer already exists" ||
    message === "cloud computer slot is taken"
  ) {
    return m.computer_cloud_extra_exists();
  }
  if (message === "default cloud computer is not ready") return m.computer_cloud_not_ready();
  if (message === "cloud cluster is not configured") return m.computer_cloud_unavailable();
  if (message === "workspace access denied") return m.computer_cloud_access_denied();
  return m.computer_cloud_create_error();
}
