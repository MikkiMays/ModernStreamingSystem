import { Track } from 'livekit-client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { hasFeature, notifyDesktop, onDesktopEvent } from '../core/desktop';
import { desktopCaptureAudio, selectCaptureSource, type CaptureAudio } from '../core/desktop-capture';
import type { Meeting } from '../core/meeting';
import { humans, presentHumans } from '../core/people';
import { Store } from '../core/store';
import type { Panel } from './Sidebar';

/**
 * Встреча для окон оболочки Windows поверх других программ (R63, R93, R104): виджет говорящих в игре
 * и мини-окно звонка.
 *
 * Что уходит оболочке:
 * - `overlay.roster` — кто во встрече: id, имя, аватар (`data:`, ≤ 4 КиБ) и выключен ли микрофон;
 *   только когда состав изменился;
 * - `overlay.levels` — ступень и уровень голоса каждого при каждом изменении (до 30 раз в секунду, без
 *   прежнего дросселя 100 мс). Это сообщение preload кладёт прямо в порты окон оболочки, мимо main;
 *   измеритель в клиенте — `AudioWorklet` (`media/levels.ts`): он работает, и когда Cord спрятан;
 * - `mini.state` — название встречи, микрофон, камера, показ, непрочитанные, сколько людей и связь со
 *   звуком (`status`: идёт или восстанавливается, `remaining` — сколько секунд ещё ждать); сразу, как
 *   что-то поменялось. Пока связь восстанавливается, нажатия микрофона, камеры и показа встреча не
 *   исполняет (как пульт) — мини-окно по `status` гасит эти кнопки, а не принимает их впустую.
 * Оболочка до R63 (без флага `overlay.widget`) получает прежнее `overlay.state` — имена и ступени
 * без аватаров, не чаще 10 раз в секунду.
 *
 * Что приходит: `mini.action {id}` — нажатие в мини-окне (микрофон, камера, показ, участники, чат,
 * настройки, выход) и `golive {id, name}` — «Показать игру»: показ окна игры с тем же качеством, что
 * выбрано в окне показа, в режиме «Плавность» и со звуком игры. Жест для `getDisplayMedia` оболочка
 * дала странице сама, поэтому показ начинается без окна выбора.
 *
 * Мини-окно не должно «замерзать» (R137, оболочка 1.0.11):
 * - нажатие несёт нужное состояние (`want`: включить или выключить, а не «переключить») — два быстрых
 *   нажатия до нового состояния не отменяют друг друга; без `want` (оболочка до 1.0.11) — переключение;
 * - на нажатие с номером (`seq`) встреча отвечает `mini.ack {seq, result, reason?}`: сделано (или уже
 *   так) либо нет и почему — мини-окно снимает с кнопки «ожидание»;
 * - `mini.state` несёт номер (растёт при изменении) и повторяется раз в 5 с и по `mini.resync` — вместе
 *   с составом: пропавшее сообщение не оставляет мини-окно со старым состоянием навсегда.
 */
export interface DesktopOverlayActions {
  setPanel: (panel: Panel) => void;
  openSettings: () => void;
  leave: () => void;
}

/** «Показать экран» из мини-окна: пульт открывает своё окно выбора (`CallDock`). */
export const shareRequests = new Store(0);

/** Предел виджета — как у оболочки (`ROSTER_SIZE` в `messages.ts`). */
const ROSTER_SIZE = 25;
const AVATAR_LIMIT = 4096;
/** Как часто повторять состояние мини-окна, даже если ничего не менялось (R137). */
export const MINI_REPEAT_MS = 5000;

/** Ответ на нажатие мини-окна: сделано (или уже так) либо нет — и код причины. */
type MiniResult = { result: 'ok' } | { result: 'ignored'; reason: 'link' | 'busy' | 'failed' | 'unknown' };
const ok: MiniResult = { result: 'ok' };
const ignored = (reason: 'link' | 'busy' | 'failed' | 'unknown'): MiniResult => ({
  result: 'ignored',
  reason,
});

export function useDesktopOverlay(meeting: Meeting, ended: boolean, actions: DesktopOverlayActions) {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });

  // Состав и уровни голоса — виджету в игре и мини-окну.
  useEffect(() => {
    if (ended || !hasFeature('overlay')) return;
    if (!hasFeature('overlay.widget') && !hasFeature('mini')) return legacyOverlay(meeting);
    let sent = '';
    let ids: string[] = [];
    const roster = () => {
      const self = meeting.admission.participantId;
      const microphone = meeting.media.state.get().microphone;
      const speakingTracks = new Set(
        meeting.media.tracks
          .get()
          .filter((tile) => tile.source === Track.Source.Microphone && !tile.muted)
          .map((tile) => tile.participantId),
      );
      const participants = presentHumans(meeting.snapshot.get().participants)
        .slice(0, ROSTER_SIZE)
        .map((person) => ({
          id: person.id,
          name: person.name.slice(0, 40),
          // У человека без картинки ядро шлёт null (`RoomState.Member.avatar`), хоть схема и пишет string.
          avatar:
            typeof person.avatar === 'string' &&
            person.avatar.startsWith('data:image/') &&
            person.avatar.length <= AVATAR_LIMIT
              ? person.avatar
              : '',
          muted: person.id === self ? !microphone : !speakingTracks.has(person.id),
        }));
      const next = JSON.stringify(participants);
      if (next === sent) return;
      sent = next;
      ids = participants.map((person) => person.id);
      notifyDesktop('overlay.roster', { participants });
      levels();
    };
    const levels = () => {
      const state = meeting.media.levels.state.get();
      notifyDesktop('overlay.levels', {
        levels: ids.flatMap((id) => (state[id] ? [[id, state[id].tier, state[id].level]] : [])),
      });
    };
    const stops = [
      meeting.snapshot.subscribe(roster),
      meeting.media.tracks.subscribe(roster),
      meeting.media.state.subscribe(roster),
      meeting.media.levels.watchAll(levels),
      // Мини-окно не дождалось ответа (R137): состав — заново, даже если он не менялся.
      onDesktopEvent('mini.resync', () => {
        sent = '';
        roster();
      }),
    ];
    roster();
    return () => {
      stops.forEach((stop) => stop());
      notifyDesktop('overlay.roster', { participants: [] });
    };
  }, [meeting, ended]);

  // Мини-окно звонка: что показывать.
  useEffect(() => {
    if (ended || !hasFeature('mini')) return;
    let sent = '';
    let seq = 0;
    /** `again` — повторить последнее с тем же номером, даже если ничего не менялось. */
    const publish = (again = false) => {
      const media = meeting.media.state.get();
      const state = {
        room: meeting.admission.snapshot.title.slice(0, 80),
        self: meeting.admission.participantId,
        mic: media.microphone,
        camera: media.camera,
        screen: media.screen,
        unread: meeting.unread.get(),
        count: presentHumans(meeting.snapshot.get().participants).length,
        status: media.status === 'connected' || media.status === 'recovering' ? media.status : 'connecting',
        remaining: media.status === 'recovering' ? Math.max(0, Math.ceil(media.remaining)) : 0,
      };
      const next = JSON.stringify(state);
      if (next === sent && !again) return;
      if (next !== sent) seq += 1;
      sent = next;
      notifyDesktop('mini.state', { ...state, seq });
    };
    const changed = () => publish();
    const stops = [
      meeting.media.state.subscribe(changed),
      meeting.unread.subscribe(changed),
      meeting.snapshot.subscribe(changed),
      onDesktopEvent('mini.resync', () => publish(true)),
    ];
    publish();
    const repeat = setInterval(() => publish(true), MINI_REPEAT_MS);
    return () => {
      clearInterval(repeat);
      stops.forEach((stop) => stop());
    };
  }, [meeting, ended]);

  // Нажатия в мини-окне и «Показать игру».
  useEffect(() => {
    if (ended) return;
    const live = () => !meeting.ended.get() && meeting.media.state.get().status === 'connected';
    /**
     * Нажатие мини-окна. `want` — нужное состояние: уже так — ничего не делать; нет — переключиться
     * один раз и сказать, вышло ли. Без `want` — переключить, как оболочка до 1.0.11.
     */
    const run = async (id: unknown, want: boolean | undefined): Promise<MiniResult> => {
      const media = meeting.media.state.get();
      switch (id) {
        case 'mic':
          if (!live()) return ignored('link');
          if (want === undefined) {
            await meeting.media.toggle('microphone');
            return ok;
          }
          if (media.microphone === want) return ok;
          // Цель, а не переключение: если микрофон сейчас переключается, она дождётся его (≤ 5 с).
          await meeting.media.setMicrophone(want);
          return meeting.media.state.get().microphone === want ? ok : ignored('failed');
        case 'camera':
          if (!live()) return ignored('link');
          if (want === undefined) {
            await meeting.media.toggle('camera');
            return ok;
          }
          if (media.camera === want) return ok;
          await meeting.media.toggle('camera');
          // Камера ещё переключалась от прежнего нажатия — это не исполнено, мини-окно покажет как есть.
          return meeting.media.state.get().camera === want ? ok : ignored('busy');
        case 'screen':
          if (!live()) return ignored('link');
          if (want !== undefined && media.screen === want) return ok;
          if (media.screen) void meeting.media.stopScreen();
          else shareRequests.update((count) => count + 1);
          return ok;
        case 'people':
        case 'chat':
          latest.current.setPanel(id);
          return ok;
        case 'settings':
          latest.current.openSettings();
          return ok;
        case 'leave':
          latest.current.leave();
          return ok;
        default:
          return ignored('unknown');
      }
    };
    const stops = [
      onDesktopEvent('mini.action', ({ id, want, seq }) => {
        const target = typeof want === 'boolean' ? want : undefined;
        const answer = (result: MiniResult) => {
          // Ответ — только оболочке 1.0.11+: она шлёт номер; прежняя его не ждёт.
          if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0)
            notifyDesktop('mini.ack', { seq, ...result });
        };
        void run(id, target).then(answer, () => answer(ignored('failed')));
      }),
      onDesktopEvent('golive', ({ id }) => {
        if (
          typeof id !== 'string' ||
          !/^window:\d+:\d+$/.test(id) ||
          !live() ||
          meeting.media.state.get().screen
        )
          return;
        // Игра — «Плавность» и частота 60 (DESIGN.md → Оверлей); разрешение — как выбрано в окне показа.
        const profile = {
          ...meeting.media.preferences.get().screen,
          mode: 'smooth' as const,
          fps: 60 as const,
        };
        const audio: CaptureAudio = hasFeature('capture.app-audio') ? 'app' : 'none';
        void selectCaptureSource(id, audio).then(() =>
          meeting.media.share(profile, desktopCaptureAudio(audio)),
        );
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [meeting, ended]);
}

/** Оболочка до R63: имена и ступени без аватаров — не чаще 10 раз в секунду (T23, E01). */
function legacyOverlay(meeting: Meeting): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    timer = null;
    last = Date.now();
    const levels = meeting.media.levels.state.get();
    const speaking = new Set(meeting.media.speaking.get());
    notifyDesktop('overlay.state', {
      participants: humans(meeting.snapshot.get().participants)
        .slice(0, 20)
        .map((p) => ({
          name: p.name.slice(0, 40),
          tier: levels[p.id]?.tier ?? 0,
          speaking: speaking.has(p.id),
        })),
    });
  };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, 100 - (Date.now() - last));
    timer = setTimeout(publish, wait);
  };
  const stops = [meeting.media.levels.watchAll(schedule), meeting.snapshot.subscribe(schedule)];
  schedule();
  return () => {
    stops.forEach((stop) => stop());
    if (timer) clearTimeout(timer);
    notifyDesktop('overlay.state', { participants: [] });
  };
}
