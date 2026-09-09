import type { ScreenProfile } from '../media/profiles';
import type { DeviceChoice } from '../media/session';

export interface Preferences {
  screen: ScreenProfile;
  camera: ScreenProfile;
  devices: DeviceChoice;
}
const key = 'cord:preferences:v1';
const defaultScreen: ScreenProfile = { resolution: 1080, fps: 30, mode: 'text', automatic: true };
const defaultCamera: ScreenProfile = { resolution: 720, fps: 30, mode: 'motion', automatic: true };
function profile(value: Partial<ScreenProfile> | undefined, fallback: ScreenProfile): ScreenProfile {
  return {
    resolution: [720, 1080, 1440].includes(value?.resolution ?? 0) ? value!.resolution! : fallback.resolution,
    fps: [15, 30, 60].includes(value?.fps ?? 0) ? value!.fps! : fallback.fps,
    mode: value?.mode === 'text' || value?.mode === 'motion' ? value.mode : fallback.mode,
    automatic: typeof value?.automatic === 'boolean' ? value.automatic : true,
    automaticFps: typeof value?.automaticFps === 'boolean' ? value.automaticFps : (value?.fps ?? 30) === 30,
  };
}
export function readPreferences(): Preferences {
  let data: Partial<Preferences> = {};
  try {
    data = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    /* Use defaults. */
  }
  const devices: DeviceChoice = {};
  for (const kind of ['camera', 'microphone', 'speaker'] as const)
    if (typeof data.devices?.[kind] === 'string') devices[kind] = data.devices[kind];
  return {
    screen: profile(data.screen, defaultScreen),
    camera: profile(data.camera, defaultCamera),
    devices,
  };
}
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = { ...readPreferences(), ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* Still apply for this call. */
  }
  return next;
}
export function automaticProfile(kind: 'screen' | 'camera'): ScreenProfile {
  return { ...(kind === 'screen' ? defaultScreen : defaultCamera) };
}
