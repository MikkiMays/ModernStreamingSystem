import type { RoomApi } from '../api/client';
import type { Ack, Command, RoomEvent, Snapshot } from '../api/types';
import { Store } from './store';

type Packet =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: RoomEvent }
  | { type: 'authenticated' | 'pong' }
  | { type: 'ack'; ack: Ack }
  | { type: 'error'; message: string; code: string };

export class ControlChannel {
  readonly state = new Store<'connecting' | 'connected' | 'recovering' | 'closed'>('connecting');
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposed = false;
  private attempt = 0;
  private lastPong = Date.now();
  private sequence = -1;
  private pending = new Map<string, (ack: Ack) => void>();
  constructor(
    private api: RoomApi,
    private onSnapshot: (snapshot: Snapshot) => void,
    private onEvent: (event: RoomEvent) => void,
    private onRevoked: () => void,
  ) {}
  start() {
    window.addEventListener('online', this.network);
    this.connect();
  }
  private network = () => {
    if (this.socket?.readyState !== WebSocket.OPEN && this.socket?.readyState !== WebSocket.CONNECTING) {
      clearTimeout(this.timer);
      this.connect();
    }
  };
  private connect = () => {
    if (this.disposed) return;
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`,
    );
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          roomId: this.api.admission.roomId,
          credential: this.api.credential,
          after: this.sequence,
        }),
      );
      this.lastPong = Date.now();
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.disposed) return;
      try {
        const packet = JSON.parse(String(message.data)) as Packet;
        switch (packet.type) {
          case 'authenticated':
            this.attempt = 0;
            this.state.set('connected');
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.lastPong > 15000) socket.close();
              else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
            }, 5000);
            break;
          case 'pong':
            this.lastPong = Date.now();
            break;
          case 'snapshot':
            this.sequence = packet.snapshot.sequence;
            this.onSnapshot(packet.snapshot);
            break;
          case 'event':
            if (packet.event.version !== 1) {
              this.sequence = -1;
              socket.close();
              break;
            }
            if (packet.event.sequence <= this.sequence) break;
            if (packet.event.sequence !== this.sequence + 1) {
              this.sequence = -1;
              socket.close();
              break;
            }
            this.sequence = packet.event.sequence;
            this.onEvent(packet.event);
            break;
          case 'ack':
            this.pending.get(packet.ack.commandId)?.(packet.ack);
            break;
          case 'error':
            if (['FORBIDDEN', 'HISTORY_EXPIRED'].includes(packet.code)) {
              this.dispose();
              this.onRevoked();
            }
            break;
        }
      } catch {
        this.sequence = -1;
        socket.close();
      }
    };
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.disposed || this.socket !== socket) return;
      this.state.set('recovering');
      this.timer = setTimeout(this.connect, Math.min(3000, [0, 500, 1000, 2000][this.attempt++] ?? 3000));
    };
    socket.onerror = () => socket.close();
  };
  async command(command: Command): Promise<Ack> {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state.get() !== 'connected')
      return this.api.command(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId);
        void this.api.command(command).then(resolve, reject);
      }, 2500);
      this.pending.set(command.commandId, (ack) => {
        clearTimeout(timer);
        this.pending.delete(command.commandId);
        resolve(ack);
      });
      this.socket!.send(JSON.stringify({ type: 'command', command }));
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    window.removeEventListener('online', this.network);
    this.socket?.close();
    this.state.set('closed');
  }
}
