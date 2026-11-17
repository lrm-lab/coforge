/** A Task's grey locator after its title, as text (a tooltip, a label): `#7`, or `#7 · #design`
 * for another channel's. */
export function taskMetaLabel(task: { number: number; channel?: string | null }) {
  return task.channel ? `#${task.number} · #${task.channel}` : `#${task.number}`;
}
