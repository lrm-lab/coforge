/**
 * The short form of a Message id, as the CLI prints and accepts it: the first twelve hex
 * characters with the first dash kept (`xxxxxxxx-xxxx`). Twelve hex is the full UUIDv7
 * millisecond timestamp, so ids minted in different milliseconds never collide; the resolver's
 * "at most one match" rule refuses the rare same-millisecond pair loudly.
 *
 * One rule for the display form, the `--around`/`--before` targets and the thread reference.
 */
export function shortId(id: string): string {
  return id.slice(0, 13);
}
