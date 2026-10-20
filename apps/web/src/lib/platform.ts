/** Whether the viewer is on a Mac or iOS device, whose shortcuts use Cmd where others use Ctrl.
 * False on the server: read it after mount when the result is rendered. */
export function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform;
  return /Mac|iPhone|iPad|iPod|macOS|iOS/i.test(platform);
}
