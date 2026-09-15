import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type RemoteTrack,
  type RemoteTrackPublication,
  LocalVideoTrack,
  LocalAudioTrack,
  ConnectionQuality,
  DisconnectReason,
  type Participant,
  type LocalTrack,
  type VideoCodec,
} from 'livekit-client';
import { ApiError, type RoomApi } from '../api/client';
import { Store } from '../core/store';
import { RecoveryWindow } from '../core/recovery';
import {
  chooseCodec,
  fitSource,
  screenOptions,
  cameraCapture,
  cameraOptions,
  targetBitrate,
  type ScreenProfile,
} from './profiles';
import { AutoQuality } from './auto-quality';
import {
  readPreferences,
  savePreferences,
  type AudioPreferences,
  type Preferences,
} from '../core/preferences';
import { audioCapture, CordAudioProcessor, needsAudioProcessor } from './audio';
import { browserCapture, type CaptureAdapter } from './capture';
import { EncoderHealth } from './encoder-health';
import { LiveHealth } from './live-health';
import { preferRealtimePlayout } from './playout';
import { waitForPublishPermissions } from './publish-permissions';

export interface MediaTile {
  id: string;
  participantId: string;
  name: string;
  source: Track.Source;
  track: Track;
  local: boolean;
  muted: boolean;
}
export interface MediaState {
  status: 'idle' | 'connecting' | 'connected' | 'recovering' | 'ended';
  remaining: number;
  microphone: boolean;
  camera: boolean;
  screen: boolean;
  error: string | null;
  quality: ConnectionQuality;
  liveStatus: string | null;
}
export interface DeviceChoice {
  microphone?: string;
  camera?: string;
  speaker?: string;
}

/** This is the only owner of the Room and capture tracks. React only subscribes. */
export class MediaSession {
  readonly preferences = new Store(readPreferences());
  readonly state = new Store<MediaState>({
    status: 'idle',
    remaining: 20,
    microphone: false,
    camera: false,
    screen: false,
    error: null,
    quality: ConnectionQuality.Unknown,
    liveStatus: null,
  });
  readonly tracks = new Store<MediaTile[]>([]);
  readonly volumes = new Store<Record<string, number>>({});
  readonly deafened = new Store(false);
  private previousVolumes = new Map<string, number>();
  private watchedParticipant: string | null = null;
  watchScreen(participantId: string | null) {
    this.watchedParticipant = participantId;
    this.syncSubscriptions();
  }
  private shouldSubscribe(identity: string, source: Track.Source) {
    return (
      ![Track.Source.ScreenShare, Track.Source.ScreenShareAudio].includes(source) ||
      identity === this.watchedParticipant
    );
  }
  private syncSubscriptions = () => {
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) {
        const wanted = this.shouldSubscribe(participant.identity, publication.source);
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
      }
  };
  toggleParticipantMute(id: string) {
    const volume = this.volumes.get()[id] ?? 1;
    if (volume > 0) {
      this.previousVolumes.set(id, volume);
      this.setVolume(id, 0);
    } else this.setVolume(id, this.previousVolumes.get(id) ?? 1);
  }
  private audioChange: Promise<void> = Promise.resolve();
  readonly recovery: RecoveryWindow;
  readonly room: Room;
  private disposed = false;
  private generation = 0;
  private deadlineTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private screenTracks: LocalTrack[] = [];
  private deviceTracks = new Map<Track.Source, LocalTrack>();
  private captureSize = { width: 1920, height: 1080 };
  private profile = this.preferences.get().screen;
  private cameraProfile = this.preferences.get().camera;
  private cameraChange: Promise<void> = Promise.resolve();
  private cameraProfilePending = false;
  private codec: VideoCodec = 'vp8';
  private screenBusy = false;
  private screenPublishAbort?: AbortController;
  private deviceBusy = new Set<string>();
  private wanted = { microphone: false, camera: false };
  private connectionCycle = 0;
  private profileChange: Promise<void> = Promise.resolve();
  private mediaReport: Promise<void> = Promise.resolve();
  private refreshQueued = false;
  private fullRetry = 0;
  private qualityTimer?: ReturnType<typeof setInterval>;
  private screenGeneration = 0;
  private liveTimer?: ReturnType<typeof setInterval>;
  private liveNoticeTimer?: ReturnType<typeof setTimeout>;
  private liveSampling = false;
  private liveHealth = new Map<string, LiveHealth>();
  private lastLiveReset = new Map<string, number>();
  private resetting = new Set<string>();
  private liveAbort = new AbortController();
  constructor(
    private api: RoomApi,
    private onEnd: (reason: string) => void,
    private capture: CaptureAdapter = browserCapture,
  ) {
    this.recovery = new RecoveryWindow((api.admission.recoverySeconds || 20) * 1000);
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      stopLocalTrackOnUnpublish: false,
      videoCaptureDefaults: {
        ...cameraCapture(this.cameraProfile),
        deviceId: this.preferences.get().devices.camera || undefined,
      },
      audioCaptureDefaults: {
        ...audioCapture(this.preferences.get().audio),
        deviceId: this.preferences.get().devices.microphone || undefined,
      },
      audioOutput: { deviceId: this.preferences.get().devices.speaker || undefined },
      publishDefaults: cameraOptions(this.cameraProfile),
      reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => this.recovery.delay(retryCount) },
    });
    this.room
      .on(RoomEvent.Reconnecting, this.lost)
      .on(RoomEvent.SignalReconnecting, this.lost)
      .on(RoomEvent.Reconnected, this.connected)
      .on(RoomEvent.Connected, this.connected)
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.disposed) return;
        if (
          reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.ROOM_DELETED ||
          reason === DisconnectReason.DUPLICATE_IDENTITY
        ) {
          this.dispose();
          this.onEnd(
            reason === DisconnectReason.DUPLICATE_IDENTITY
              ? 'Встреча открыта в другом окне'
              : 'Доступ к встрече завершён',
          );
          return;
        }
        this.lost();
        this.scheduleConnect();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.isLocal) this.patch({ quality });
      });
    this.room
      .on(RoomEvent.TrackPublished, this.syncSubscriptions)
      .on(RoomEvent.ParticipantConnected, this.syncSubscriptions)
      .on(RoomEvent.TrackSubscribed, this.configurePlayout)
      .on(RoomEvent.TrackSubscribed, this.refreshTracks)
      .on(RoomEvent.TrackUnsubscribed, this.refreshTracks)
      .on(RoomEvent.TrackUnpublished, this.refreshTracks)
      .on(RoomEvent.LocalTrackPublished, this.refreshTracks)
      .on(RoomEvent.LocalTrackUnpublished, this.refreshTracks)
      .on(RoomEvent.ParticipantConnected, this.refreshTracks)
      .on(RoomEvent.ParticipantDisconnected, this.refreshTracks)
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (participant.isLocal && publication.source === Track.Source.Microphone)
          this.wanted.microphone = false;
        this.refreshTracks();
      })
      .on(RoomEvent.TrackUnmuted, this.refreshTracks);
    window.addEventListener('online', this.network);
    this.liveTimer = setInterval(() => void this.checkLive(), 2000);
  }
  private configurePlayout = (track: RemoteTrack) => {
    // Use the same preference for audio and video. This is not a forced zero-sized buffer.
    preferRealtimePlayout(track?.receiver);
  };
  private async checkLive() {
    if (this.disposed || this.liveSampling || this.state.get().status !== 'connected' || document.hidden)
      return;
    this.liveSampling = true;
    const cycle = this.connectionCycle;
    const active = new Set<string>();
    try {
      const jobs: Promise<void>[] = [];
      for (const participant of this.room.remoteParticipants.values())
        for (const publication of participant.videoTrackPublications.values()) {
          if (
            !publication.isSubscribed ||
            !publication.isEnabled ||
            publication.isMuted ||
            !publication.track
          )
            continue;
          active.add(publication.trackSid);
          jobs.push(
            (async () => {
              const report = await publication.track!.getRTCStatsReport();
              if (this.disposed || cycle !== this.connectionCycle) return;
              const health = this.liveHealth.get(publication.trackSid) ?? new LiveHealth();
              this.liveHealth.set(publication.trackSid, health);
              let reset = false;
              report?.forEach((stat) => {
                if (stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video')
                  reset ||= health.observe(stat);
              });
              if (reset) await this.resetLivePair(participant.identity, publication.source, true);
            })().catch(() => {}),
          );
        }
      await Promise.all(jobs);
      for (const key of this.liveHealth.keys()) if (!active.has(key)) this.liveHealth.delete(key);
      for (const key of this.lastLiveReset.keys())
        if (!this.room.remoteParticipants.has(key.split(':')[0]!)) this.lastLiveReset.delete(key);
    } finally {
      this.liveSampling = false;
    }
  }
  async returnToLive() {
    if (this.disposed || this.state.get().status !== 'connected') return;
    await Promise.all(
      [...this.room.remoteParticipants.values()].flatMap((p) => [
        this.resetLivePair(p.identity, Track.Source.Camera, false),
        this.resetLivePair(p.identity, Track.Source.ScreenShare, false),
      ]),
    );
  }
  private async resetLivePair(identity: string, source: Track.Source, automatic: boolean) {
    const screen = source === Track.Source.ScreenShare;
    const key = `${identity}:${screen ? 'screen' : 'camera'}`;
    if (this.resetting.has(key) || (automatic && Date.now() - (this.lastLiveReset.get(key) ?? 0) < 30000))
      return;
    const participant = this.room.remoteParticipants.get(identity);
    if (!participant) return;
    const sources = screen
      ? [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
      : [Track.Source.Camera, Track.Source.Microphone];
    const publications = [...participant.trackPublications.values()].filter(
      (p) => sources.includes(p.source) && p.isSubscribed && p.isEnabled && !p.isMuted,
    );
    if (!publications.length) return;
    this.resetting.add(key);
    this.lastLiveReset.set(key, Date.now());
    this.patch({ liveStatus: 'Обновляем прямой эфир…' });
    try {
      await Promise.all(publications.map((p) => this.unsubscribeForRefresh(p)));
    } finally {
      // Restore the same publication even if an ICE restart began while waiting. Never touch a replacement session.
      if (!this.disposed)
        for (const publication of publications) {
          if (
            this.room.remoteParticipants.get(identity)?.trackPublications.get(publication.trackSid) ===
              publication &&
            this.shouldSubscribe(identity, publication.source)
          )
            publication.setSubscribed(true);
        }
      this.resetting.delete(key);
      clearTimeout(this.liveNoticeTimer);
      if (!this.disposed)
        this.liveNoticeTimer = setTimeout(() => {
          if (!this.disposed) this.patch({ liveStatus: null });
        }, 2500);
    }
  }
  private unsubscribeForRefresh(publication: RemoteTrackPublication) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.liveAbort.signal.removeEventListener('abort', done);
        publication.off(TrackEvent.Unsubscribed, done);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      this.liveAbort.signal.addEventListener('abort', done, { once: true });
      publication.once(TrackEvent.Unsubscribed, done);
      publication.setSubscribed(false);
    });
  }
  private patch(value: Partial<MediaState>) {
    this.state.update((s) => ({ ...s, ...value }));
  }
  report(error: unknown) {
    this.patch({ error: error instanceof Error ? error.message : 'Не удалось выполнить действие' });
  }
  clearError() {
    this.patch({ error: null });
  }
  async start() {
    if (this.connecting || this.disposed || this.state.get().status === 'connected') return;
    this.connecting = true;
    const generation = this.generation;
    if (!this.recovery.active) this.patch({ status: 'connecting' });
    try {
      if (this.recovery.active) await this.api.resume();
      const { url, token } = await this.api.token();
      if (this.disposed || generation !== this.generation) return;
      await this.room.connect(url, token, {
        autoSubscribe: false,
        peerConnectionTimeout: 10000,
        websocketTimeout: 5000,
      });
      if (this.disposed || generation !== this.generation) await this.room.disconnect();
    } catch (error) {
      if (!this.disposed) {
        if (error instanceof ApiError && [403, 404, 410].includes(error.status)) {
          this.dispose();
          this.onEnd(error.message);
          return;
        }
        this.report(error);
        this.lost();
        this.scheduleConnect();
      }
    } finally {
      this.connecting = false;
    }
  }
  private scheduleConnect() {
    clearTimeout(this.reconnectTimer);
    if (this.recovery.remaining() <= 0 || this.disposed) return;
    const delay = this.recovery.delay(this.fullRetry++);
    if (delay === null) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.connecting) void this.start();
      else this.scheduleConnect();
    }, delay);
  }
  private network = () => {
    // The SDK owns retries while signaling is reconnecting. Only restart after it has disconnected.
    if (this.recovery.active && this.room.state === 'disconnected' && !this.connecting) {
      clearTimeout(this.reconnectTimer);
      void this.start();
    }
  };
  private lost = () => {
    if (this.disposed) return;
    this.liveHealth.clear();
    const fresh = this.deadlineTimer === undefined;
    const epoch = this.recovery.begin();
    this.patch({ status: 'recovering', remaining: Math.ceil(this.recovery.remaining() / 1000) });
    if (!fresh) return;
    this.connectionCycle++;
    this.reportConnection('media.lost', () => this.recovery.current(epoch));
    clearInterval(this.deadlineTimer);
    this.deadlineTimer = setInterval(() => {
      if (!this.recovery.current(epoch)) return;
      const remaining = this.recovery.remaining();
      this.patch({ remaining: Math.ceil(remaining / 1000) });
      if (remaining <= 0) {
        this.dispose();
        this.onEnd(`Соединение не восстановилось за ${this.recovery.durationMs / 1000} секунд`);
      }
    }, 100);
  };
  private connected = () => {
    if (this.disposed) return;
    if (this.recovery.active && this.recovery.remaining() <= 0) {
      this.dispose();
      this.onEnd('Время восстановления истекло');
      return;
    }
    this.syncSubscriptions();
    this.recovery.recovered();
    clearInterval(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.reconnectTimer);
    this.fullRetry = 0;
    const cycle = ++this.connectionCycle;
    this.reportConnection(
      'media.restored',
      () => cycle === this.connectionCycle && this.room.state === 'connected',
    );
    void this.restoreTracks(cycle);
    this.patch({ status: 'connected', remaining: this.recovery.durationMs / 1000, error: null });
    this.refreshTracks();
  };
  private refreshTracks = () => {
    if (this.disposed || this.refreshQueued) return;
    this.refreshQueued = true;
    // LiveKit emits TrackUnsubscribed before clearing the publication's track.
    // Read after that synchronous mutation, and coalesce related SDK events.
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.collectTracks();
    });
  };
  private reportConnection(type: 'media.lost' | 'media.restored', current: () => boolean) {
    this.mediaReport = this.mediaReport
      .then(async () => {
        if (this.disposed || !current()) return;
        const snapshot = await this.api.snapshot();
        const member = snapshot.participants.find((p) => p.id === this.api.admission.participantId);
        if (member && !this.disposed && current())
          await this.api.command({ type, commandId: crypto.randomUUID(), generation: member.generation });
      })
      .catch(() => {});
  }
  private collectTracks() {
    if (this.disposed) return;
    const tiles: MediaTile[] = [];
    const collect = (participant: Participant) => {
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          tiles.push({
            id: publication.trackSid,
            participantId: participant.identity,
            name: participant.name || 'Участник',
            source: publication.source,
            track: publication.track,
            local: participant.isLocal,
            muted: publication.isMuted,
          });
    };
    collect(this.room.localParticipant);
    for (const publication of this.room.localParticipant.trackPublications.values()) {
      if (publication.track && [Track.Source.Camera, Track.Source.Microphone].includes(publication.source))
        this.deviceTracks.set(publication.source, publication.track);
    }
    for (const [source, track] of this.deviceTracks)
      if (track.mediaStreamTrack.readyState === 'ended') this.deviceTracks.delete(source);
    this.room.remoteParticipants.forEach(collect);
    this.tracks.set(tiles);
    const local = this.room.localParticipant;
    this.patch({
      microphone: local.isMicrophoneEnabled,
      camera: local.isCameraEnabled,
      screen: local.isScreenShareEnabled,
    });
  }
  private async restoreTracks(cycle: number) {
    try {
      for (const [source, wanted] of [
        [Track.Source.Camera, this.wanted.camera],
        [Track.Source.Microphone, this.wanted.microphone],
      ] as const) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (!wanted || this.room.localParticipant.getTrackPublication(source)?.track) continue;
        const track = this.deviceTracks.get(source);
        if (track && track.mediaStreamTrack.readyState === 'live')
          await this.room.localParticipant.publishTrack(track, {
            ...(source === Track.Source.Camera ? cameraOptions(this.cameraProfile) : {}),
            source,
          });
        else if (source === Track.Source.Camera)
          await this.room.localParticipant.setCameraEnabled(
            true,
            cameraCapture(this.cameraProfile),
            cameraOptions(this.cameraProfile),
          );
        else {
          await this.room.localParticipant.setMicrophoneEnabled(
            true,
            audioCapture(this.preferences.get().audio, this.preferences.get().devices.microphone),
          );
          await this.applyAudioProcessor();
        }
      }
      for (const track of this.screenTracks) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (
          track.mediaStreamTrack.readyState !== 'live' ||
          this.room.localParticipant.getTrackPublication(track.source)?.track
        )
          continue;
        await this.room.localParticipant.publishTrack(track, {
          ...screenOptions(this.profile, this.codec),
          source: track.source,
          ...(track.kind === Track.Kind.Audio
            ? { audioPreset: { maxBitrate: 128000 }, forceStereo: true, dtx: false }
            : {}),
        });
      }
      this.refreshTracks();
    } catch (error) {
      if (!this.disposed) this.report(error);
    }
  }
  async toggle(kind: 'microphone' | 'camera', deviceId?: string) {
    if (this.deviceBusy.has(kind) || this.disposed) return;
    this.deviceBusy.add(kind);
    try {
      const reusedCamera =
        kind === 'camera' && !!this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      deviceId ||= this.preferences.get().devices[kind] || undefined;
      if (kind === 'microphone') {
        await this.room.localParticipant.setMicrophoneEnabled(
          !this.state.get().microphone,
          audioCapture(this.preferences.get().audio, deviceId),
        );
        if (this.room.localParticipant.isMicrophoneEnabled) await this.applyAudioProcessor();
      } else
        await this.room.localParticipant.setCameraEnabled(
          !this.state.get().camera,
          { deviceId, ...cameraCapture(this.cameraProfile) },
          cameraOptions(this.cameraProfile),
        );
      this.wanted[kind] =
        kind === 'microphone'
          ? this.room.localParticipant.isMicrophoneEnabled
          : this.room.localParticipant.isCameraEnabled;
      if (kind === 'camera' && !reusedCamera) this.cameraProfilePending = false;
      if (kind === 'camera' && this.wanted.camera && this.cameraProfilePending)
        await this.setCameraProfile(this.cameraProfile);
      this.refreshTracks();
    } catch (error) {
      this.report(error);
    } finally {
      this.deviceBusy.delete(kind);
    }
  }
  saveSettings(patch: Partial<Preferences>) {
    this.preferences.set(savePreferences(patch));
  }
  setVolume(participantId: string, volume: number) {
    if (!Number.isFinite(volume)) return;
    this.volumes.update((values) => ({ ...values, [participantId]: Math.max(0, Math.min(2, volume)) }));
  }
  async setAudioSettings(audio: AudioPreferences) {
    this.audioChange = this.audioChange.then(async () => {
      if (this.disposed) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      try {
        if (track instanceof LocalAudioTrack) {
          await track.applyConstraints(audioCapture(audio));
          await this.applyAudioProcessor(audio);
        }
        this.preferences.set(savePreferences({ audio }));
      } catch (error) {
        this.report(error);
      }
    });
    return this.audioChange;
  }
  private async applyAudioProcessor(audio = this.preferences.get().audio) {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    if (needsAudioProcessor(audio)) await track.setProcessor(new CordAudioProcessor(audio));
    else if (track.getProcessor()) await track.stopProcessor();
  }
  async switchDevice(kind: MediaDeviceKind, id: string) {
    const activeCamera = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const previous =
      this.preferences.get().devices[
        kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker'
      ] ||
      (kind === 'videoinput' && activeCamera instanceof LocalVideoTrack
        ? activeCamera.mediaStreamTrack.getSettings().deviceId
        : undefined);
    try {
      await this.room.switchActiveDevice(kind, id);
      const devices = {
        ...this.preferences.get().devices,
        [kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker']: id,
      };
      this.preferences.set(savePreferences({ devices }));
    } catch (error) {
      if (kind === 'videoinput' && previous)
        await this.room.switchActiveDevice(kind, previous).catch(() => {});
      this.report(error);
    }
  }
  async flipCamera() {
    if (this.deviceBusy.has('camera') || this.disposed) return;
    this.deviceBusy.add('camera');
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const previous =
      this.preferences.get().devices.camera ||
      (track instanceof LocalVideoTrack ? track.mediaStreamTrack.getSettings().deviceId : undefined);
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
      if (!this.state.get().camera) {
        const index = devices.findIndex((d) => d.deviceId === previous);
        const next = devices[(index + 1) % devices.length];
        if (next) await this.switchDevice('videoinput', next.deviceId);
        return;
      }
      if (!(track instanceof LocalVideoTrack)) return;
      const currentFacing = track.mediaStreamTrack.getSettings().facingMode;
      const next = devices[(devices.findIndex((d) => d.deviceId === previous) + 1) % devices.length];
      await track.restartTrack({
        ...cameraCapture(this.cameraProfile),
        deviceId: currentFacing ? undefined : next?.deviceId,
        facingMode: currentFacing ? (currentFacing === 'environment' ? 'user' : 'environment') : undefined,
      });
      const id = track.mediaStreamTrack.getSettings().deviceId;
      if (id) this.saveSettings({ devices: { ...this.preferences.get().devices, camera: id } });
      this.refreshTracks();
    } catch (error) {
      if (track instanceof LocalVideoTrack)
        await track
          .restartTrack({ ...cameraCapture(this.cameraProfile), deviceId: previous })
          .catch(() => {});
      this.report(error);
    } finally {
      this.deviceBusy.delete('camera');
    }
  }
  /**
   * Camera zoom, where the platform exposes it. It is an optional constraint: Android Chrome
   * implements it, iOS Safari does not, and a desktop webcam usually has no zoom at all. The
   * caller gets null in those cases and should not offer the gesture.
   */
  cameraZoom(): { min: number; max: number; step: number; value: number } | null {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return null;
    const media = track.mediaStreamTrack;
    const zoom = (media.getCapabilities?.() as { zoom?: { min: number; max: number; step?: number } })
      ?.zoom;
    if (!zoom || !(zoom.max > zoom.min)) return null;
    const current = (media.getSettings() as { zoom?: number }).zoom;
    return {
      min: zoom.min,
      max: zoom.max,
      step: zoom.step && zoom.step > 0 ? zoom.step : (zoom.max - zoom.min) / 100,
      value: typeof current === 'number' ? current : zoom.min,
    };
  }

  async applyCameraZoom(value: number) {
    const range = this.cameraZoom();
    if (!range) return;
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    const clamped = Math.min(range.max, Math.max(range.min, value));
    try {
      // Zoom is an "advanced" constraint: browsers that do not know it ignore this silently
      // rather than failing the whole call, which is why it is applied on its own.
      await track.mediaStreamTrack.applyConstraints({
        advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
      });
    } catch {
      /* A camera may refuse a zoom it advertised; keep the call alive regardless. */
    }
  }

  /** Must be called directly from the click handler, before any await. */
  share(profile: ScreenProfile): void {
    if (this.screenBusy || this.disposed) return;
    if (this.state.get().screen) {
      void this.stopScreen();
      return;
    }
    if (!this.capture.supported()) {
      this.report(new Error('Этот браузер не поддерживает демонстрацию экрана'));
      return;
    }
    this.screenBusy = true;
    const capture = this.capture.capture(profile);
    void this.publishScreen(capture, profile).finally(() => {
      this.screenBusy = false;
    });
  }
  private async publishScreen(capture: Promise<MediaStream>, profile: ScreenProfile) {
    let stream: MediaStream | undefined;
    let reserved = false;
    const operation = new AbortController();
    this.screenPublishAbort = operation;
    const captureEnded = () => operation.abort();
    try {
      stream = await capture;
      if (this.disposed || operation.signal.aborted) return;
      const video = stream.getVideoTracks()[0];
      if (!video) throw new Error('Не удалось получить экран');
      video.addEventListener('ended', captureEnded, { once: true });
      const settings = video.getSettings();
      this.captureSize = { width: settings.width ?? 1920, height: settings.height ?? 1080 };
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await video.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      // The hint follows the same rule as the degradation preference: a chosen level holds its
      // frame rate, so the encoder is told to favour motion; automatic favours legibility.
      video.contentHint = profile.automatic ? 'detail' : 'motion';
      this.codec = await chooseCodec(profile);
      this.profile = profile;
      if (this.disposed || operation.signal.aborted || video.readyState !== 'live') return;
      const reservation = await this.api.screen(true);
      reserved = true;
      await waitForPublishPermissions(
        this.room,
        stream
          .getTracks()
          .map((track) =>
            track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          ),
        operation.signal,
      );
      if (this.disposed || operation.signal.aborted || video.readyState !== 'live') return;
      for (const track of stream.getTracks()) {
        const publication = await this.room.localParticipant.publishTrack(track, {
          ...screenOptions(profile, this.codec),
          source: track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          ...(track.kind === 'audio'
            ? { audioPreset: { maxBitrate: 128000 }, forceStereo: true, dtx: false }
            : {}),
        });
        if (publication.track) this.screenTracks.push(publication.track);
        if (this.disposed || operation.signal.aborted) {
          await this.stopScreen();
          return;
        }
      }
      if (reservation.value)
        await this.api.command({
          type: 'screen.started',
          commandId: crypto.randomUUID(),
          targetId: reservation.value,
        });
      video.removeEventListener('ended', captureEnded);
      video.addEventListener(
        'ended',
        () => {
          if (this.screenTracks.some((track) => track.mediaStreamTrack === video)) void this.stopScreen();
        },
        { once: true },
      );
      this.refreshTracks();
      this.monitorEncoder();
      stream = undefined;
    } catch (error) {
      if (!(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)))
        this.report(error);
      await this.stopScreen();
    } finally {
      if (this.screenPublishAbort === operation) this.screenPublishAbort = undefined;
      if (stream) {
        stream.getVideoTracks()[0]?.removeEventListener('ended', captureEnded);
        stream.getTracks().forEach((t) => t.stop());
        if (reserved) await this.api.screen(false).catch(() => {});
      }
    }
  }
  async stopScreen() {
    this.screenPublishAbort?.abort();
    this.screenGeneration++;
    clearInterval(this.qualityTimer);
    const tracks = this.screenTracks;
    this.screenTracks = [];
    for (const track of tracks) {
      try {
        await this.room.localParticipant.unpublishTrack(track, true);
      } catch {
        track.stop();
      }
    }
    await this.api.screen(false).catch(() => {});
    this.refreshTracks();
  }
  setProfile(profile: ScreenProfile) {
    this.profile = profile;
    this.preferences.set(savePreferences({ screen: profile }));
    this.profileChange = this.profileChange.then(() => this.applyProfile(this.profile));
    return this.profileChange;
  }
  setCameraProfile(profile: ScreenProfile) {
    this.cameraProfile = profile;
    this.cameraProfilePending = true;
    this.preferences.set(savePreferences({ camera: profile }));
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      this.deviceBusy.add('camera');
      try {
        await track.restartTrack({
          ...cameraCapture(this.cameraProfile),
          deviceId: this.preferences.get().devices.camera || undefined,
        });
        if (this.disposed) return;
        await this.room.localParticipant.unpublishTrack(track, false);
        if (this.disposed) return;
        await this.room.localParticipant.publishTrack(track, {
          ...cameraOptions(this.cameraProfile),
          source: Track.Source.Camera,
        });
        this.cameraProfilePending = false;
        if (this.disposed) track.stop();
        this.refreshTracks();
      } catch (error) {
        this.report(error);
      } finally {
        this.deviceBusy.delete('camera');
      }
    });
    return this.cameraChange;
  }
  private async applyProfile(profile: ScreenProfile) {
    const track = this.screenTracks.find((t) => t instanceof LocalVideoTrack);
    if (!(track instanceof LocalVideoTrack)) return;
    const generation = this.screenGeneration;
    try {
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await track.mediaStreamTrack.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      track.mediaStreamTrack.contentHint = profile.automatic ? 'detail' : 'motion';
      if (this.disposed || generation !== this.screenGeneration) return;
      await this.room.localParticipant.unpublishTrack(track, false);
      if (this.disposed || generation !== this.screenGeneration) return;
      await this.room.localParticipant.publishTrack(track, {
        ...screenOptions(profile, this.codec),
        source: Track.Source.ScreenShare,
      });
      if (this.disposed || generation !== this.screenGeneration) {
        await this.room.localParticipant.unpublishTrack(track, true);
        return;
      }
      this.refreshTracks();
    } catch (error) {
      this.report(error);
    }
  }
  get requestedProfile() {
    return this.profile;
  }
  private monitorEncoder() {
    clearInterval(this.qualityTimer);
    const health = new EncoderHealth();
    const auto = new AutoQuality();
    const generation = this.screenGeneration;
    let sampling = false;
    this.qualityTimer = setInterval(() => {
      const track = this.screenTracks.find((t) => t instanceof LocalVideoTrack);
      if (!track || sampling || this.disposed) return;
      sampling = true;
      void track
        .getRTCStatsReport()
        .then((report) => {
          let limitation = 'none';
          let available: number | null = null;
          report?.forEach((stat) => {
            if (stat.type === 'outbound-rtp' && typeof stat.qualityLimitationReason === 'string')
              if (stat.qualityLimitationReason !== 'none') limitation = stat.qualityLimitationReason;
            if (stat.type === 'candidate-pair' && typeof stat.availableOutgoingBitrate === 'number')
              available = stat.availableOutgoingBitrate;
          });
          if (this.disposed || generation !== this.screenGeneration) return;
          if (health.observe(limitation, this.codec === 'av1' || this.codec === 'vp9')) {
            this.codec = 'vp8';
            void this.setProfile(this.profile);
            this.report(new Error('Кодировщик перегружен. Переключаем экран на совместимый кодек.'));
            return;
          }
          // A chosen level is the user's instruction, not a suggestion: only automatic moves.
          if (!this.profile.automatic) return;
          const next = auto.observe(limitation, available, targetBitrate(this.profile));
          if (next) void this.setProfile({ ...this.profile, ...next });
        })
        .catch(() => {})
        .finally(() => {
          sampling = false;
        });
    }, 3000);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.screenPublishAbort?.abort();
    this.liveAbort.abort();
    this.generation++;
    this.screenGeneration++;
    this.recovery.stop();
    this.liveHealth.clear();
    this.lastLiveReset.clear();
    clearInterval(this.liveTimer);
    clearTimeout(this.liveNoticeTimer);
    clearInterval(this.deadlineTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.qualityTimer);
    window.removeEventListener('online', this.network);
    this.screenTracks.forEach((t) => t.stop());
    this.deviceTracks.forEach((t) => t.stop());
    this.deviceTracks.clear();
    this.screenTracks = [];
    void this.room.disconnect(true);
    this.tracks.set([]);
    this.patch({ status: 'ended', screen: false, camera: false, microphone: false });
  }
}
