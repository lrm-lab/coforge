/** The fill of a Task's step bar, by how far it got: amber under half, blue past it, green done. */
export function taskStepsProgressClass(finished: number, total: number): string {
  if (finished >= total) return "bg-success-solid";
  return finished * 2 < total ? "bg-warning-solid" : "bg-utility-blue-500";
}
