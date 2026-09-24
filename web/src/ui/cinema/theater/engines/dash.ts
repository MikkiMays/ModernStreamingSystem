import type { MediaInfo, MediaPlayerClass, Representation } from 'dashjs';
import type { Level } from '../watch-levels';
import { audioChoices, type AudioChoice, type MediaTrack } from '../watch-tracks';
import type { Playback } from './playback';

export async function attachDash(
  video: HTMLVideoElement,
  url: string,
  language: string,
  callbacks: {
    alive: () => boolean;
    levels: (levels: Level[], current: number) => void;
    voices: (voices: AudioChoice[], current: number) => void;
    error: () => void;
  },
): Promise<Playback | null> {
  const { MediaPlayer } = await import('dashjs');
  if (!callbacks.alive()) return null;
  const player: MediaPlayerClass = MediaPlayer().create();
  let representations: Representation[] = [];
  let levels: Level[] = [];
  let tracks: MediaInfo[] = [];
  let disposed = false;
  const active = () => !disposed && callbacks.alive();
  const read = () => {
    if (!active()) return;
    representations = player.getRepresentationsByTypeUnfiltered('video');
    const current = player.getCurrentRepresentationForType('video');
    levels = representations.map((r) => ({
      height: r.height,
      bitrate: r.bandwidth,
      videoCodec: r.codecs ?? undefined,
      attrs: { 'FRAME-RATE': String(r.frameRate) },
    }));
    callbacks.levels(
      levels,
      representations.findIndex((r) => r.id === current?.id),
    );
    tracks = player.getTracksFor('audio');
    const voice = player.getCurrentTrackFor('audio');
    const names: MediaTrack[] = tracks.map((t) => ({
      lang: t.lang ?? '',
      name: t.labels?.[0]?.text ?? t.lang ?? '',
    }));
    callbacks.voices(
      audioChoices(names),
      tracks.findIndex((t) => t.id === voice?.id),
    );
  };
  player.updateSettings({
    debug: { logLevel: 0 },
    streaming: {
      abr: { limitBitrateByPortal: false, autoSwitchBitrate: { video: true, audio: true } },
      // Replacing buffered media during a simultaneous room seek races codec changes.
      // Apply manual quality at the next segment boundary instead.
      buffer: { fastSwitchEnabled: false },
    },
  });
  // The engine has already filtered unsupported codecs. Choose the widest supported
  // video ladder once; keep ABR within that codec to avoid decoder resets during seeks.
  player.setCustomInitialTrackSelectionFunction((available) => {
    if (available[0]?.type === 'audio') {
      const original = available.filter((track) => track.roles?.some((role) => role.value === 'main'));
      const voices = original.length ? original : available;
      const aac = voices.filter((track) => track.codec?.includes('mp4a.40.2'));
      return aac.length ? aac : voices;
    }
    if (available[0]?.type !== 'video') return available;
    const height = (track: MediaInfo) => Math.max(0, ...track.bitrateList.map((r) => r.height ?? 0));
    const largest = Math.max(...available.map(height));
    return available.filter((track) => height(track) === largest);
  });
  if (language) player.setInitialMediaSettingsFor('audio', { lang: language });
  player.on(MediaPlayer.events.STREAM_INITIALIZED, read);
  player.on(MediaPlayer.events.QUALITY_CHANGE_RENDERED, read);
  player.on(MediaPlayer.events.TRACK_CHANGE_RENDERED, read);
  player.on(MediaPlayer.events.ERROR, () => {
    if (active()) callbacks.error();
  });
  player.initialize(video, url, false);
  return {
    get levels() {
      return levels;
    },
    quality(index) {
      player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: index < 0 } } } });
      const representation = representations[index];
      if (representation) player.setRepresentationForTypeById('video', representation.id, false);
    },
    voice(index) {
      const track = tracks[index];
      if (track) player.setCurrentTrack(track);
      return track?.lang ?? '';
    },
    destroy() {
      disposed = true;
      player.reset();
    },
  };
}
