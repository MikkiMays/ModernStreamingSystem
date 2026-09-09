import { Upload } from 'tus-js-client';
import type { RoomApi } from '../api/client';
import { Store } from './store';

export class Uploader {
  readonly state = new Store<{
    name: string;
    progress: number;
    status: 'idle' | 'uploading' | 'paused' | 'done' | 'error';
    error?: string;
  }>({ name: '', progress: 0, status: 'idle' });
  private upload?: Upload;
  private attachmentId?: string;
  private stopped = false;
  private congestionPaused = false;
  private networkPoor = false;
  private generation = 0;
  private pending?: { file: File; commandId: string };
  private reserving = false;
  private aborting: Promise<void> = Promise.resolve();
  constructor(
    private api: RoomApi,
    private onComplete: () => void,
  ) {}
  async start(file: File, commandId: string = crypto.randomUUID()) {
    if (['uploading', 'paused'].includes(this.state.get().status)) return;
    if (this.state.get().status === 'error' && this.pending?.file !== file) await this.cancel();
    const generation = ++this.generation;
    this.stopped = false;
    this.pending = { file, commandId };
    this.upload = undefined;
    this.attachmentId = undefined;
    this.reserving = true;
    this.congestionPaused = this.networkPoor;
    this.state.set({ name: file.name, progress: 0, status: this.networkPoor ? 'paused' : 'uploading' });
    try {
      const attachment = await this.api.reserve(file.name, file.size, commandId);
      if (this.stopped || generation !== this.generation) {
        await this.api.cancel(attachment.id);
        return;
      }
      this.attachmentId = attachment.id;
      this.upload = new Upload(file, {
        endpoint: `${location.origin}/uploads/`,
        uploadUrl: attachment.uploadId ? `${location.origin}/uploads/${attachment.uploadId}` : undefined,
        headers: { Authorization: `Bearer ${this.api.credential}` },
        metadata: { attachmentId: attachment.id },
        chunkSize: 512 * 1024,
        retryDelays: [0, 500, 1000, 2000, 3000],
        removeFingerprintOnSuccess: true,
        storeFingerprintForResuming: false,
        onProgress: (sent, total) => {
          if (generation === this.generation)
            this.state.update((s) => ({ ...s, progress: total ? sent / total : 0 }));
        },
        onSuccess: () => {
          if (generation !== this.generation) return;
          this.state.update((s) => ({ ...s, status: 'done', progress: 1 }));
          this.onComplete();
        },
        onError: (error) => {
          if (generation === this.generation)
            this.state.update((s) => ({ ...s, status: 'error', error: error.message }));
        },
      });
      if (this.state.get().status === 'uploading') this.upload.start();
    } catch (error) {
      if (generation !== this.generation) return;
      this.state.update((s) => ({
        ...s,
        status: 'error',
        error: error instanceof Error ? error.message : 'Ошибка загрузки',
      }));
    } finally {
      if (generation === this.generation) this.reserving = false;
    }
  }
  async pause(congestion = false) {
    if (this.state.get().status !== 'uploading') return;
    this.congestionPaused = congestion;
    this.state.update((s) => ({ ...s, status: 'paused' }));
    this.aborting = this.upload?.abort() ?? Promise.resolve();
    await this.aborting;
  }
  async resume() {
    if (this.stopped || !['paused', 'error'].includes(this.state.get().status)) return;
    await this.aborting;
    if (this.networkPoor) {
      this.congestionPaused = true;
      this.state.update((s) => ({ ...s, status: 'paused' }));
      return;
    }
    if (!this.upload && this.pending) {
      if (this.reserving) {
        this.state.update((s) => ({ ...s, status: 'uploading' }));
        return;
      }
      this.state.update((s) => ({ ...s, status: 'error' }));
      await this.start(this.pending.file, this.pending.commandId);
      return;
    }
    if (!this.upload) return;
    const generation = this.generation;
    this.congestionPaused = false;
    try {
      if (!this.upload.url && this.attachmentId) {
        const stored = (await this.api.files()).find((file) => file.id === this.attachmentId);
        if (generation !== this.generation) return;
        if (stored?.uploadId) this.upload.url = `${location.origin}/uploads/${stored.uploadId}`;
      }
      if (generation !== this.generation) return;
      this.state.update((s) => ({ ...s, status: 'uploading', error: undefined }));
      this.upload.start();
    } catch (error) {
      if (generation === this.generation)
        this.state.update((s) => ({ ...s, status: 'error', error: (error as Error).message }));
    }
  }
  async congestion(poor: boolean) {
    this.networkPoor = poor;
    if (poor) await this.pause(true);
    else if (this.congestionPaused && this.state.get().status === 'paused') await this.resume();
  }
  async cancel() {
    this.stopped = true;
    this.generation++;
    this.pending = undefined;
    await this.upload?.abort();
    if (this.attachmentId && this.state.get().status !== 'done')
      await this.api.cancel(this.attachmentId).catch(() => {});
    this.upload = undefined;
    this.attachmentId = undefined;
    this.state.set({ name: '', progress: 0, status: 'idle' });
    this.onComplete();
  }
}
