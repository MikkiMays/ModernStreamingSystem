import { useEffect, useState } from 'react';
import { Track } from 'livekit-client';
import type { Meeting } from '../core/meeting';

/**
 * The level of the microphone track the meeting is actually publishing, 0 to 100.
 *
 * It reads the published track rather than opening its own, so what the slider shows is what
 * the room hears, including whatever processing is in front of it. The track is replaced when
 * the device or the processing changes, so the analyser is rebuilt whenever it does, and the
 * meter simply reads zero while the microphone is off.
 */
export function useMicLevel(meeting?: Meeting | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!meeting) return;
    let context: AudioContext | undefined;
    let analyser: AnalyserNode | undefined;
    let attached: MediaStreamTrack | undefined;
    let data = new Float32Array(0);

    const release = () => {
      analyser?.disconnect();
      analyser = undefined;
      attached = undefined;
      void context?.close().catch(() => {});
      context = undefined;
    };

    const timer = setInterval(() => {
      const published = meeting.media.room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      )?.track?.mediaStreamTrack;
      if (!published || published.readyState !== 'live') {
        if (attached) release();
        setLevel(0);
        return;
      }
      if (published !== attached) {
        release();
        try {
          context = new AudioContext();
          analyser = context.createAnalyser();
          analyser.fftSize = 512;
          context.createMediaStreamSource(new MediaStream([published])).connect(analyser);
          data = new Float32Array(analyser.fftSize);
          attached = published;
        } catch {
          release();
          return;
        }
      }
      if (!analyser) return;
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      const db = 20 * Math.log10(Math.max(rms, 0.000001));
      setLevel(Math.round(Math.max(0, Math.min(100, ((db + 60) / 60) * 100))));
    }, 100);

    return () => {
      clearInterval(timer);
      release();
    };
  }, [meeting]);
  return level;
}
