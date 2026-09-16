import { notifyDesktop } from './desktop';
import type { ScreenProfile } from '../media/profiles';
import type { DeviceChoice } from '../media/session';
import type { NetworkMode } from '../media/playout';
import { defaultMicHotkey, validHotkey, type Hotkey } from './hotkeys';

export const networkModes: NetworkMode[] = ['auto', 'low-latency', 'stable'];

export interface AudioPreferences {
  suppression: 'off' | 'browser' | 'rnnoise' | 'voice';
  echoCancellation: boolean;
  autoGainControl: boolean;
  gain: number;
}
export const defaultAudio: AudioPreferences = {
  suppression: 'browser',
  echoCancellation: true,
  autoGainControl: true,
  gain: 1,
};

export interface Preferences {
  showPing: boolean;
  notificationSounds: boolean;
  showIntegrationPanel: boolean;
  yandexMusicToken: string;
  screen: ScreenProfile;
  camera: ScreenProfile;
  devices: DeviceChoice;
  audio: AudioPreferences;
  /**
   * Чем жертвовать, когда канал не даёт и непрерывности, и отзывчивости сразу.
   * Влияет только на запас буфера приёма; ни переподключения, ни смены кодеков.
   */
  network: NetworkMode;
  name: string;
  /** A small square data URI shown to the room, or an empty string. */
  avatar: string;
  micHotkey: Hotkey | null;
}
const key = 'cord:preferences:v1';
const defaultScreen: ScreenProfile = { resolution: 1080, fps: 30, automatic: true };
const defaultCamera: ScreenProfile = { resolution: 720, fps: 30, automatic: true };
// Settings saved before the content mode was removed still carry it; the extra key is ignored.
function profile(value: Partial<ScreenProfile> | undefined, fallback: ScreenProfile): ScreenProfile {
  return {
    resolution: [720, 1080, 1440].includes(value?.resolution ?? 0) ? value!.resolution! : fallback.resolution,
    fps: [15, 30, 60].includes(value?.fps ?? 0) ? value!.fps! : fallback.fps,
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
    showPing: data.showPing === true,
    notificationSounds: data.notificationSounds !== false,
    showIntegrationPanel: data.showIntegrationPanel !== false,
    yandexMusicToken: typeof data.yandexMusicToken === 'string' ? data.yandexMusicToken : '',
    screen: profile(data.screen, defaultScreen),
    camera: profile(data.camera, defaultCamera),
    devices,
    audio: {
      suppression: ['off', 'browser', 'rnnoise', 'voice'].includes(data.audio?.suppression ?? '')
        ? data.audio!.suppression
        : 'browser',
      echoCancellation:
        typeof data.audio?.echoCancellation === 'boolean' ? data.audio.echoCancellation : true,
      autoGainControl: typeof data.audio?.autoGainControl === 'boolean' ? data.audio.autoGainControl : true,
      gain:
        typeof data.audio?.gain === 'number' && Number.isFinite(data.audio.gain)
          ? Math.max(0, Math.min(2, data.audio.gain))
          : 1,
    },
    network: networkModes.includes(data.network as NetworkMode) ? data.network! : 'auto',
    name: (localStorage.getItem('cord:name') ?? (typeof data.name === 'string' ? data.name : '')).slice(
      0,
      40,
    ),
    // The server checks this again before showing it to anyone; this only keeps a corrupt
    // entry from being sent in the first place.
    avatar:
      typeof data.avatar === 'string' && data.avatar.startsWith('data:image/') && data.avatar.length <= 3500
        ? data.avatar
        : '',
    micHotkey:
      data.micHotkey === null ? null : validHotkey(data.micHotkey) ? data.micHotkey : { ...defaultMicHotkey },
  };
}
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = { ...readPreferences(), ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(next));
    if (patch.name !== undefined) localStorage.setItem('cord:name', patch.name.trim().slice(0, 40));
  } catch {
    /* Still apply for this call. */
  }
  window.dispatchEvent(new Event('cord:preferences'));
  notifyDesktop('preferences.changed', {
    showPing: next.showPing,
    notificationSounds: next.notificationSounds,
  });
  return next;
}
export function automaticProfile(kind: 'screen' | 'camera'): ScreenProfile {
  return { ...(kind === 'screen' ? defaultScreen : defaultCamera) };
}
