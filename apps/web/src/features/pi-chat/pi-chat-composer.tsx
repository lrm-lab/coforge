import { Send01, StopCircle, Edit03 } from "@untitledui/icons";
import type { PiChatQueue, PiChatModel } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { m } from "#src/paraglide/messages";
import type { PiChatDraft } from "./pi-chat-state";

export function PiChatComposer({
  draft,
  onDraft,
  busy,
  pending,
  controls,
  models,
  modelError,
  sessionModel,
  queue,
  heldQueue,
  onSend,
  onStop,
  onTakeQueue,
  terminalStatus,
}: {
  draft: PiChatDraft;
  onDraft(value: PiChatDraft): void;
  busy: boolean;
  pending: boolean;
  controls: boolean;
  models?: (PiChatModel & { name: string })[];
  modelError: boolean;
  sessionModel?: string;
  queue?: PiChatQueue;
  heldQueue?: PiChatQueue;
  onSend(): Promise<void>;
  onStop(): Promise<void>;
  onTakeQueue(): Promise<void>;
  terminalStatus?: string;
}) {
  const mode = draft.mode ?? "steer";
  const pendingCount = (queue?.steering.length ?? 0) + (queue?.followUp.length ?? 0);
  const heldText = [...(heldQueue?.steering ?? []), ...(heldQueue?.followUp ?? [])].join("\n\n");
  const items = (models ?? []).map((model) => ({
    id: JSON.stringify({ provider: model.provider, id: model.id }),
    label: `${model.name} · ${model.provider}`,
  }));
  const activeModel =
    draft.model ?? models?.find((model) => `${model.provider}/${model.id}` === sessionModel);
  const selected = activeModel
    ? JSON.stringify({ provider: activeModel.provider, id: activeModel.id })
    : null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
      className="shrink-0 px-page pt-2 pb-4"
    >
      <div className="mx-auto max-w-[48rem] space-y-2">
        {terminalStatus && (
          <p role="status" className="text-xs text-tertiary">
            {terminalStatus}
          </p>
        )}
        {heldText && (
          <div className="rounded-lg border border-secondary p-3 text-sm text-secondary">
            <p className="text-xs text-tertiary">{m.pi_chat_queue_held()}</p>
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
              {heldText}
            </p>
            <Button
              size="sm"
              color="tertiary"
              isDisabled={pending}
              onClick={() => void onTakeQueue()}
            >
              {m.pi_chat_queue_restore()}
            </Button>
          </div>
        )}
        {pendingCount > 0 && (
          <div className="rounded-lg border border-secondary p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-secondary">
                {m.pi_chat_queue_count({ count: String(pendingCount) })}
              </p>
              <Button
                size="sm"
                color="tertiary"
                iconLeading={Edit03}
                isDisabled={pending}
                onClick={() => void onTakeQueue()}
              >
                {m.pi_chat_queue_edit()}
              </Button>
            </div>
            <ol
              aria-label={m.pi_chat_queue_count({ count: String(pendingCount) })}
              className="max-h-32 space-y-2 overflow-y-auto text-sm text-secondary"
            >
              {(["steering", "followUp"] as const).flatMap((kind) =>
                (queue?.[kind] ?? []).map((text, index) => (
                  <li key={`${kind}:${index}`} className="whitespace-pre-wrap wrap-anywhere">
                    <span className="mr-2 text-xs text-tertiary">
                      {kind === "steering" ? m.pi_chat_steer() : m.pi_chat_follow_up()}
                    </span>
                    {text}
                  </li>
                )),
              )}
            </ol>
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-primary bg-primary shadow-xs focus-within:border-secondary">
          <TextArea
            aria-label={m.pi_chat_message()}
            placeholder={busy ? m.pi_chat_busy_placeholder() : m.pi_chat_placeholder()}
            value={draft.text}
            onChange={(text) => onDraft({ ...draft, text, request: undefined })}
            maxLength={100_000}
            rows={1}
            textAreaClassName="min-h-12 max-h-48 resize-none rounded-none bg-transparent text-sm shadow-none ring-0 focus:ring-0 [field-sizing:content]"
            onTextAreaKeyDown={(event) => {
              if (
                event.altKey &&
                event.key === "ArrowUp" &&
                (pendingCount > 0 || !!heldText) &&
                !pending
              ) {
                event.preventDefault();
                void onTakeQueue();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void onSend();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
            <div className="min-w-0 flex-1 basis-40">
              {controls && items.length > 0 ? (
                <Select
                  aria-label={m.pi_chat_model()}
                  size="sm"
                  items={items}
                  selectedKey={selected}
                  placeholder={m.pi_chat_model_default()}
                  isDisabled={busy || pending}
                  onSelectionChange={(key) => {
                    const model = models?.find(
                      (model) => JSON.stringify({ provider: model.provider, id: model.id }) === key,
                    );
                    if (model)
                      onDraft({
                        ...draft,
                        model: { provider: model.provider, id: model.id },
                        request: undefined,
                      });
                  }}
                >
                  {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
              ) : (
                <span className="text-xs text-tertiary wrap-anywhere">
                  {sessionModel || m.pi_chat_model_default()}
                </span>
              )}
            </div>
            {busy && controls && (
              <div className="w-32 shrink-0">
                <Select
                  aria-label={m.pi_chat_delivery_mode()}
                  size="sm"
                  selectedKey={mode}
                  items={[
                    { id: "steer", label: m.pi_chat_steer() },
                    { id: "followUp", label: m.pi_chat_follow_up() },
                  ]}
                  onSelectionChange={(key) => {
                    if (key === "steer" || key === "followUp")
                      onDraft({ ...draft, mode: key, request: undefined });
                  }}
                >
                  {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              {busy && (
                <Button
                  color="secondary"
                  size="sm"
                  iconLeading={StopCircle}
                  isDisabled={pending}
                  onClick={() => void onStop()}
                >
                  {m.pi_chat_stop()}
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                iconLeading={Send01}
                isDisabled={pending || !draft.text.trim() || (busy && !controls)}
                isLoading={pending}
              >
                {busy
                  ? mode === "steer"
                    ? m.pi_chat_steer()
                    : m.pi_chat_follow_up()
                  : m.pi_chat_send()}
              </Button>
            </div>
          </div>
        </div>
        {modelError && (
          <p role="alert" className="text-xs text-error-primary">
            {m.pi_chat_models_error()}
          </p>
        )}
        {!controls && <p className="text-xs text-tertiary">{m.pi_chat_controls_upgrade()}</p>}
        <p className="text-xs text-tertiary">
          {pendingCount ? m.pi_chat_queue_shortcut() : m.pi_chat_keyboard_hint()}
        </p>
      </div>
    </form>
  );
}
