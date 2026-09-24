import { vi } from 'vitest';
import type { CinemaAt, ProviderId } from '../core/cinema';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';

/**
 * Встреча для сцен кинозала в тестах: комната с одним ведущим, хранилища открытой площадки и её
 * страницы (`cinema`, `cinemaAt`), настройки профиля с недавними ссылками — и `openCinema`, который
 * меняет их так же, как настоящая встреча: страницу раньше площадки, без страницы — `null`.
 */
export function sceneMeeting(provider: ProviderId, links: string[] = []) {
  const cinema = new Store<ProviderId | null>(provider);
  const cinemaAt = new Store<CinemaAt | null>(null);
  const preferences = new Store({ cinemaLinks: links });
  const saveSettings = vi.fn((patch: { cinemaLinks?: string[] }) =>
    preferences.set({ ...preferences.get(), ...patch }),
  );
  const openCinema = vi.fn((next: ProviderId | null, at?: CinemaAt) => {
    cinemaAt.set(next && at ? at : null);
    cinema.set(next);
  });
  const command = vi.fn(() => Promise.resolve());
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'self', owner: true }],
      integrationsAllowed: true,
      watch: null,
    }),
    cinema,
    cinemaAt,
    media: { preferences, saveSettings },
    command,
    openCinema,
  };
  return meeting as unknown as Meeting & {
    command: typeof command;
    openCinema: typeof openCinema;
    media: { saveSettings: typeof saveSettings };
  };
}

/** Ответ fetch в форме службы: тело JSON и код. */
export function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}
