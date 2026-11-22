export function taskMetaLabel(task: { number: number; channel?: string | null }) {
  return task.channel ? `#${task.number} #${task.channel}` : `#${task.number}`;
}
