export type DevicePermission = 'granted' | 'denied' | 'unavailable';
export type DevicePermissions = Record<'camera' | 'microphone', DevicePermission>;
let pending: Promise<DevicePermissions> | undefined;

async function check(kind: 'camera' | 'microphone'): Promise<DevicePermission> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  try {
    const state = await navigator.permissions?.query({ name: kind as PermissionName });
    if (state?.state === 'granted' || state?.state === 'denied') return state.state;
  } catch {
    /* Safari may not expose these Permissions API descriptors. */
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'camera' ? { video: true } : { audio: true },
    );
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (error) {
    return error instanceof DOMException && error.name === 'NotFoundError' ? 'unavailable' : 'denied';
  }
}
/** Coalesce preview mounts; the browser remains the authority for permission. */
export function requestDevicePermissions(): Promise<DevicePermissions> {
  if (!pending)
    pending = (async () => {
      const microphone = await check('microphone');
      const camera = await check('camera');
      const result = { microphone, camera };
      try {
        localStorage.setItem('cord:permissions', JSON.stringify(result));
      } catch {
        /* Optional cache. */
      }
      return result;
    })().finally(() => {
      pending = undefined;
    });
  return pending;
}
