import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import { Chrome } from './Chrome';

/*
  Пульт после естественного конца ролика.

  Комната не на паузе — паузы никто не ставил, её секунда просто ушла за конец, — а свой плеер стоит
  на последнем кадре. Раньше обе кнопки «играть/пауза» брали имя и действие у `watch.paused`, а
  значок у своего плеера: на экране ▶, в имени «Пауза для всех», по нажатию `watch.pause` — первое
  нажатие не делало ничего видимого, второе начинало заново. INTEGRATIONS.md обещал другое.
*/

afterEach(cleanup);

const WATCH = {
  provider: 'youtube',
  kind: 'video',
  contentId: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  openedBy: 'me',
  paused: false,
  positionMs: 0,
  anchorAt: 0,
  revision: 3,
} as Watch;

function pult(state: { paused: boolean; over: boolean; playing: boolean }) {
  const command = vi.fn();
  render(
    <Chrome
      meeting={{ media: { saveSettings: vi.fn() } } as unknown as Meeting}
      watch={{ ...WATCH, paused: state.paused }}
      source={null}
      live={false}
      canControl
      owner={undefined}
      self={undefined}
      shown
      center
      playing={state.playing}
      behind={false}
      volume={70}
      sync={{
        position: 635_000,
        duration: 635_000,
        buffered: 635_000,
        lag: 0,
        over: state.over,
        send: vi.fn(),
        command,
        skip: vi.fn(),
        resync: vi.fn(),
      }}
      player={
        {
          levels: [],
          level: -1,
          automatic: true,
          voices: [],
          voice: null,
          texts: [],
          chooseVoice: vi.fn(),
          chooseLevel: vi.fn(),
        } as never
      }
      captions={{ text: null, caption: null, chooseText: vi.fn() } as never}
      menu={false}
      onMenu={vi.fn()}
      menuPage="root"
      onMenuPage={vi.fn()}
      captionMenu={false}
      onCaptionMenu={vi.fn()}
      screen={createRef<HTMLDivElement>()}
      fullscreen={false}
      onFullscreen={vi.fn()}
    />,
  );
  return command;
}

/** Обе кнопки «играть/пауза»: посреди кадра и в полосе пульта. */
const toggles = () => [
  document.querySelector<HTMLButtonElement>('.watch-center-play')!,
  document.querySelector<HTMLButtonElement>('.watch-play')!,
];

it('досмотрели: обе кнопки — «Включить для всех» с ▶, и нажатие шлёт watch.play', () => {
  const command = pult({ paused: false, over: true, playing: false });
  for (const button of toggles()) {
    expect(button).toHaveAccessibleName('Включить для всех');
    expect(button.querySelector('svg')).toHaveClass('lucide-play');
    fireEvent.click(button);
  }
  expect(command.mock.calls).toEqual([['watch.play'], ['watch.play']]);
});

it('идёт — «Пауза для всех» с ❚❚ и watch.pause, как было', () => {
  const command = pult({ paused: false, over: false, playing: true });
  for (const button of toggles()) {
    expect(button).toHaveAccessibleName('Пауза для всех');
    expect(button.querySelector('svg')).toHaveClass('lucide-pause');
    fireEvent.click(button);
  }
  expect(command.mock.calls).toEqual([['watch.pause'], ['watch.pause']]);
});

it('комната на паузе — «Включить для всех», как было', () => {
  const command = pult({ paused: true, over: false, playing: false });
  fireEvent.click(screen.getAllByRole('button', { name: 'Включить для всех' })[1]!);
  expect(command).toHaveBeenCalledWith('watch.play');
});
