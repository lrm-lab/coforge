import { MessageBody } from "#src/features/conversations/message-body";

export function TaskDescription({ text }: { text: string }) {
  return (
    <div className="text-md text-primary">
      <MessageBody body={text} />
    </div>
  );
}
