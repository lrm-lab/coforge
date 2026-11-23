import { browserLocalStorage } from "#src/features/browser-local-storage";

export const DEVICE_FLAG_HIDDEN = "hide";
export const DEVICE_FLAG_SHOWN = "show";

export function readDeviceFlag(key: string): boolean {
  try {
    return browserLocalStorage()?.getItem(key) !== DEVICE_FLAG_HIDDEN;
  } catch {
    return true;
  }
}

export function writeDeviceFlag(key: string, show: boolean): void {
  try {
    browserLocalStorage()?.setItem(key, show ? DEVICE_FLAG_SHOWN : DEVICE_FLAG_HIDDEN);
  } catch {}
}
