import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MusicState, MusicTrack, PlatformTrack } from '../core/services';
import { IntegrationShelf } from './IntegrationShelf';
import { MusicQueue } from './MusicQueue';
import { MusicSearch, type MusicSearchAbilities } from './MusicSearch';

afterEach(cleanup);

const song = (id: string, patch: Partial<MusicTrack> = {}): MusicTrack => ({
  id,
  title: `Трек ${id}`,
  artist: 'Исполнитель',
  duration: 200,
  addedBy: 'Гость',
  source: 'youtube',
  cover: null,
  ...patch,
});

const music = (queue: MusicTrack[]): MusicState => ({
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 0,
  revision: 3,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue,
});

describe('витрина', () => {
  it('готовые группы — кнопки, «Скоро» — не кнопки, Telegram — последним', () => {
    const onOpen = vi.fn();
    render(<IntegrationShelf canLinkTelegram={false} onOpen={onOpen} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.querySelector('b')?.textContent)).toEqual(['Игры', 'Кинозал', 'Музыка']);
    for (const name of ['Любая игра', 'Сцена стендап', 'Доска рисования', 'Telegram'])
      expect(screen.getByText(name).closest('button')).toBeNull();
    expect(screen.getAllByText('Скоро')).toHaveLength(4);
    const items = screen.getAllByRole('listitem').map((li) => li.querySelector('b')?.textContent);
    expect(items.at(-1)).toBe('Telegram');
    fireEvent.click(screen.getByText('Музыка'));
    expect(onOpen).toHaveBeenCalledWith('music');
  });

  it('«подключит создатель встречи» видят все, кроме создателя (T30)', () => {
    const { rerender } = render(<IntegrationShelf canLinkTelegram={false} onOpen={() => {}} />);
    expect(screen.getByText('Подключит создатель встречи')).toBeInTheDocument();
    rerender(<IntegrationShelf canLinkTelegram onOpen={() => {}} />);
    expect(screen.queryByText('Подключит создатель встречи')).toBeNull();
  });

  it('Mini App включён: Telegram — без «Скоро», открывает его только создатель (E09, T30)', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<IntegrationShelf canLinkTelegram telegramReady onOpen={onOpen} />);
    expect(screen.getAllByText('Скоро')).toHaveLength(3);
    fireEvent.click(screen.getByText('Telegram'));
    expect(onOpen).toHaveBeenCalledWith('telegram');
    expect(screen.getByRole('group', { name: 'Связь с беседой' })).toBeInTheDocument();
    rerender(<IntegrationShelf canLinkTelegram={false} telegramReady onOpen={onOpen} />);
    expect(screen.getByText('Telegram').closest('button')).toBeNull();
    expect(screen.getByText('Подключит создатель встречи')).toBeInTheDocument();
    expect(screen.getAllByText('Скоро')).toHaveLength(3);
  });

  it('занятую соседом группу не открыть, и видно, кем занята', () => {
    render(
      <IntegrationShelf
        canLinkTelegram
        onOpen={() => {}}
        blockedBy={{ music: 'Кинозал' }}
        live={{ cinema: 'Идёт показ' }}
      />,
    );
    expect(screen.getByText('Музыка').closest('button')).toBeDisabled();
    expect(screen.getByText('Сейчас активна другая интеграция — Кинозал')).toBeInTheDocument();
    expect(screen.getByText('Кинозал').closest('button')).toHaveAttribute('data-active', 'true');
  });
});

describe('очередь', () => {
  const state = music([song('a'), song('b'), song('c'), song('d')]);

  it('играющий трек не повторяется в «Далее», у остальных — ручка', () => {
    render(
      <MusicQueue
        state={state}
        canUse
        onClear={() => {}}
        onPromote={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    );
    expect(screen.queryByText('Трек a')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Переставить:/ })).toHaveLength(3);
  });

  it('стрелки на ручке переставляют на одно место, но не выше играющего', () => {
    const onMove = vi.fn();
    render(
      <MusicQueue
        state={state}
        canUse
        onClear={() => {}}
        onPromote={() => {}}
        onRemove={() => {}}
        onMove={onMove}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить: Трек d' }), { key: 'ArrowUp' });
    expect(onMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'd' }),
      2,
      expect.objectContaining({ queue: [state.queue[0], state.queue[1], state.queue[3], state.queue[2]] }),
    );
    onMove.mockClear();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить: Трек b' }), { key: 'ArrowUp' });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить: Трек b' }), { key: 'ArrowDown' });
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 2, expect.anything());
  });

  it('без права — ручки выключены', () => {
    render(
      <MusicQueue
        state={state}
        canUse={false}
        onClear={() => {}}
        onPromote={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    );
    for (const handle of screen.getAllByRole('button', { name: /^Переставить:/ }))
      expect(handle).toBeDisabled();
  });
});

describe('поле площадки (T59)', () => {
  const found = (
    source: PlatformTrack['source'],
    title: string,
    patch: Partial<PlatformTrack> = {},
  ): PlatformTrack => ({
    url: `https://example.test/${source}/${title}`,
    title,
    artist: 'Исполнитель',
    duration: 180,
    available: true,
    source,
    ...patch,
  });
  const abilities = (patch: Partial<MusicSearchAbilities> = {}): MusicSearchAbilities => ({
    platform: 'youtube',
    offered: ['youtube', 'soundcloud', 'yandex', 'upload'],
    canSearch: true,
    searchPlatform: vi.fn(async (source: PlatformTrack['source']) =>
      source === 'youtube'
        ? [found('youtube', 'Песня')]
        : [found('soundcloud', 'Go+', { duration: 30, available: false })],
    ),
    addLink: vi.fn(async () => music([song('a'), song('новый', { title: 'Новый трек' })])),
    yandex: null,
    ...patch,
  });
  const type = (value: string) => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
    fireEvent.submit(screen.getByRole('search'));
  };

  it('название ищется только на выбранной площадке', async () => {
    const yandex = { connected: true, search: vi.fn(async () => []), add: vi.fn() };
    const can = abilities({ yandex });
    render(<MusicSearch abilities={can} onAdded={() => {}} />);
    expect(screen.getByLabelText('Найти на YouTube или вставить ссылку')).toBeInTheDocument();
    type('песня');
    expect(await screen.findByText('Песня')).toBeInTheDocument();
    expect(can.searchPlatform).toHaveBeenCalledTimes(1);
    expect(can.searchPlatform).toHaveBeenCalledWith('youtube', 'песня');
    expect(yandex.search).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Найдено: YouTube' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Найдено: SoundCloud' })).toBeNull();
  });

  it('у SoundCloud фрагмент Go+ — «Только фрагмент», без «+»', async () => {
    const can = abilities({ platform: 'soundcloud' });
    render(<MusicSearch abilities={can} onAdded={() => {}} />);
    type('песня');
    expect(await screen.findByText('Только фрагмент')).toBeInTheDocument();
    expect(can.searchPlatform).toHaveBeenCalledWith('soundcloud', 'песня');
    expect(screen.queryByRole('button', { name: /^Добавить в очередь/ })).toBeNull();
  });

  it('ссылка своей площадки уходит сразу в очередь', async () => {
    const can = abilities();
    const onAdded = vi.fn();
    render(<MusicSearch abilities={can} onAdded={onAdded} />);
    await act(async () => type('https://youtu.be/dQw4w9WgXcQ'));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(can.addLink).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
    expect(can.searchPlatform).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Добавлено: Новый трек');
  });

  it('пока ссылка скачивается, второй Enter её не повторяет', async () => {
    let finish: (state: MusicState) => void = () => {};
    const can = abilities({
      addLink: vi.fn(() => new Promise<MusicState>((resolve) => (finish = resolve))),
    });
    render(<MusicSearch abilities={can} onAdded={() => {}} />);
    await act(async () => type('https://youtu.be/dQw4w9WgXcQ'));
    await act(async () => {
      fireEvent.submit(screen.getByRole('search'));
    });
    expect(can.addLink).toHaveBeenCalledTimes(1);
    await act(async () => finish(music([song('a'), song('b')])));
  });

  it('ссылка другой площадки здесь не добавляется — «Перейти» несёт её туда', () => {
    const can = abilities();
    const onSwitch = vi.fn();
    render(<MusicSearch abilities={can} onAdded={() => {}} onSwitch={onSwitch} />);
    type('https://soundcloud.com/artist/track');
    expect(can.addLink).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Это ссылка SoundCloud');
    fireEvent.click(screen.getByRole('button', { name: 'Перейти: SoundCloud' }));
    expect(onSwitch).toHaveBeenCalledWith('soundcloud', 'https://soundcloud.com/artist/track');
  });

  it('ссылка площадки, выключенной на сервере, — отказ словами', () => {
    const can = abilities({ offered: ['youtube', 'upload'] });
    render(<MusicSearch abilities={can} onAdded={() => {}} onSwitch={vi.fn()} />);
    type('https://soundcloud.com/artist/track');
    expect(screen.getByRole('alert')).toHaveTextContent('Ссылки SoundCloud на этом сервере выключены');
    expect(screen.queryByRole('button', { name: /^Перейти/ })).toBeNull();
  });

  it('чужая ссылка получает ответ без запроса', () => {
    const can = abilities();
    render(<MusicSearch abilities={can} onAdded={() => {}} />);
    type('https://example.com/song.mp3');
    expect(screen.getByRole('alert')).toHaveTextContent('Подойдут YouTube, SoundCloud и Яндекс Музыка');
    expect(can.addLink).not.toHaveBeenCalled();
  });

  it('Яндекс: без аккаунта ссылка просит подключить аккаунт, с аккаунтом ищет только он', async () => {
    const offline = abilities({
      platform: 'yandex',
      yandex: { connected: false, search: vi.fn(), add: vi.fn() },
    });
    const { unmount } = render(<MusicSearch abilities={offline} onAdded={() => {}} />);
    type('https://music.yandex.ru/album/1/track/2');
    expect(screen.getByRole('alert')).toHaveTextContent('подключите аккаунт комнаты');
    unmount();

    const yandex = { connected: true, search: vi.fn(async () => []), add: vi.fn() };
    const online = abilities({ platform: 'yandex', yandex });
    render(<MusicSearch abilities={online} onAdded={() => {}} />);
    type('песня');
    expect(await screen.findByText('Ничего не нашлось')).toBeInTheDocument();
    expect(yandex.search).toHaveBeenCalledWith('песня');
    expect(online.searchPlatform).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Найдено: Яндекс Музыка' })).toBeInTheDocument();
  });

  it('ссылка, принесённая с другой площадки, ждёт в поле — добавить одним Enter', () => {
    render(
      <MusicSearch
        abilities={abilities({ platform: 'soundcloud' })}
        initialQuery="https://soundcloud.com/artist/track"
        onAdded={() => {}}
      />,
    );
    const field = screen.getByRole('searchbox');
    expect(field).toHaveValue('https://soundcloud.com/artist/track');
    expect(field).toHaveFocus();
  });
});
