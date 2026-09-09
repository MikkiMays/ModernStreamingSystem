import type { ScreenProfile } from './profiles';

/** A Windows/WebView host can supply capture without changing room or UI state. */
export interface CaptureAdapter {
  supported(): boolean;
  capture(profile: ScreenProfile): Promise<MediaStream>;
}

export const browserCapture: CaptureAdapter = {
  supported: () => typeof navigator.mediaDevices?.getDisplayMedia === 'function',
  capture: (profile) =>
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: profile.fps, max: profile.fps } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }),
};
