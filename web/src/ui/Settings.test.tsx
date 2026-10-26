import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences } from '../core/preferences';
import { applyLanguage } from '../i18n';
import { Settings } from './Settings';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { chrome?: unknown }).chrome;
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

/** Камера для превью «Видео»: `getUserMedia` отдаёт поток с одной дорожкой (или отказ). */
function fakeCamera(failure?: Error) {
  const track = { stop: vi.fn(), getSettings: () => ({ facingMode: 'user' }), kind: 'video' };
  const getUserMedia = vi.fn(async () => {
    if (failure) throw failure;
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      getSupportedConstraints: () => ({}),
    },
  });
  return { getUserMedia, stopped: () => track.stop.mock.calls.length > 0 };
}

const nav = () => screen.getByRole('navigation', { name: 'Разделы настроек' });
/**
 * Кнопка раздела слева. Раздел «Микрофон» (R114) и его подраздел «Микрофон» называются одинаково —
 * кнопка раздела идёт первой, подразделы открытого раздела — под ней.
 */
const sectionButton = (name: string) => within(nav()).getAllByRole('button', { name })[0]!;
const openSection = (name: string) => fireEvent.click(sectionButton(name));
/** Заголовок открытого раздела справа (у окна есть и свой — «Настройки» слева). */
const heading = () => document.querySelector('.settings-content__title')!;

describe('окно настроек (T26)', () => {
  it('слева — разделы в группах, справа — открытый раздел; прежняя вкладка «audio» ведёт в «Микрофон»', () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeInTheDocument();
    // Раздел «Звук» называется «Микрофон» (R114): рядом с «Звуками» два «Звука» путались.
    expect(heading()).toHaveTextContent('Микрофон');
    expect(sectionButton('Микрофон')).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).queryByRole('button', { name: 'Звук' })).toBeNull();
    for (const group of ['Приложение', 'Встречи', 'Подключения'])
      expect(within(nav()).getByRole('heading', { name: group })).toBeInTheDocument();
    // Подразделы открытого раздела — якоря слева.
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Микрофон' });
    expect(
      within(anchors)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Микрофон', 'Динамики']);
    openSection('О программе');
    expect(heading()).toHaveTextContent('О программе');
    expect(within(nav()).queryByRole('list', { name: /Подразделы/ })).not.toBeInTheDocument();
  });

  it('открыто мышью — фокус на заголовке раздела, а не на карточке профиля; с клавиатуры — на первом элементе (R11)', async () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    await act(async () => {});
    await vi.waitFor(() => expect(heading()).toHaveFocus());
    expect(document.querySelector('.settings-profile')).not.toHaveFocus();
    cleanup();
    document.documentElement.dataset.input = 'keyboard';
    try {
      render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
      await act(async () => {});
      await vi.waitFor(() => expect(document.querySelector('.settings-profile')).toHaveFocus());
    } finally {
      delete document.documentElement.dataset.input;
    }
  });

  it('«Микрофон» (R100, R114): микрофон с проверкой и уровнем, обработка, динамики с громкостью — камера не трогается', () => {
    const camera = fakeCamera();
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Устройство ввода' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Подстраивать громкость' })).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Громкость микрофона' })).toBeDisabled();
    expect(screen.getByRole('meter', { name: 'Уровень микрофона' })).toBeInTheDocument();
    // У одинаковых на вид «Проверить» — разные имена для диктора.
    expect(screen.getByRole('button', { name: 'Проверить микрофон' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить динамики' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Устройство вывода' })).toBeInTheDocument();
    // Шумоподавление — сегментом (S4), «Стандартное» по умолчанию.
    const noise = screen.getByRole('radiogroup', { name: 'Шумоподавление' });
    expect(within(noise).getByRole('radio', { name: 'Стандартное' })).toBeChecked();
    fireEvent.click(within(noise).getByRole('radio', { name: 'Выкл.' }));
    expect(readPreferences().audio.suppression).toBe('off');
    fireEvent.change(screen.getByRole('slider', { name: 'Громкость собеседников' }), {
      target: { value: '45' },
    });
    expect(readPreferences().outputVolume).toBe(45);
    // Камеры и показа здесь нет — и камера не включается.
    expect(screen.queryByRole('radiogroup', { name: 'Камера: качество' })).not.toBeInTheDocument();
    expect(camera.getUserMedia).not.toHaveBeenCalled();
    // «Чужое видео», «Дополнительно» и «Уступать показу экрана» убраны (R06/R08): оптимум зашит.
    expect(screen.queryByRole('switch', { name: 'Уступать показу экрана' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Дополнительно' })).not.toBeInTheDocument();
  });

  it('ползунок (R14): шаг 1, при перетаскивании запись не чаще кадра, окончательная — при отпускании', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {};
    });
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    const slider = screen.getByRole('slider', { name: 'Громкость собеседников' });
    expect(slider).toHaveAttribute('step', '1');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const writes = () => setItem.mock.calls.filter(([key]) => key === 'cord:preferences:v1').length;
    try {
      // Шестьдесят шагов перетаскивания за один кадр: бегунок и подпись едут сразу, хранилище — ждёт кадр.
      for (let value = 99; value >= 40; value--)
        fireEvent.input(slider, { target: { value: String(value) } });
      expect(slider).toHaveValue('40');
      expect(screen.getByText('40%')).toBeInTheDocument();
      expect(writes()).toBe(0);
      act(() => frames.splice(0).forEach((callback) => callback(0)));
      expect(writes()).toBe(1);
      expect(readPreferences().outputVolume).toBe(40);
      // Отпустили — окончательное значение сразу, без ожидания кадра.
      fireEvent.input(slider, { target: { value: '41' } });
      fireEvent.change(slider, { target: { value: '41' } });
      expect(readPreferences().outputVolume).toBe(41);
      act(() => frames.splice(0).forEach((callback) => callback(0)));
      expect(readPreferences().outputVolume).toBe(41);
    } finally {
      setItem.mockRestore();
    }
    // Громкость сигналов — тоже шаг 1.
    openSection('Звуки');
    expect(screen.getByRole('slider', { name: 'Громкость сигналов и звуков игр' })).toHaveAttribute(
      'step',
      '1',
    );
  });

  it('«Видео» (R100, R78): превью камеры сверху, качество камеры и показа сегментами, превью показа переключателем', async () => {
    const device = fakeCamera();
    render(<Settings open section="video" onOpenChange={vi.fn()} />);
    expect(heading()).toHaveTextContent('Видео');
    // Превью — как в Телемосте: включается само, только в этом разделе, и только для вас.
    await vi.waitFor(() => expect(device.getUserMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Превью камеры только для вас').tagName).toBe('VIDEO');
    expect(screen.getByText('Видно только вам')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Камера' })).toBeInTheDocument();
    // Качество — сегментом 720 / 1080 / 1440 × 30 / 60 (R78), без «Авто»; выше потолка сервера —
    // недоступно, причина — в подсказке пункта, а не строкой под группой.
    const camera = screen.getByRole('radiogroup', { name: 'Камера: качество' });
    expect(
      within(camera)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['720p', '1080p', '1440p']);
    expect(within(camera).getByRole('radio', { name: '720p' })).toBeChecked();
    expect(within(camera).getByRole('radio', { name: '1440p' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(camera).getByRole('radio', { name: '1440p' })).toHaveAttribute(
      'title',
      'Этот сервер допускает до 1080p · 60 fps',
    );
    fireEvent.click(within(camera).getByRole('radio', { name: '1080p' }));
    expect(readPreferences().camera.resolution).toBe(1080);
    const fps = screen.getByRole('radiogroup', { name: 'Камера: частота кадров' });
    expect(
      within(fps)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label')),
    ).toEqual(['30 fps', '60 fps']);
    fireEvent.click(within(fps).getByRole('radio', { name: '60 fps' }));
    expect(readPreferences().camera).toEqual({ resolution: 1080, fps: 60 });
    // Показ — та же шкала; под ним — что выбранное значит (X10), строки потолка больше нет.
    const shown = screen.getByRole('radiogroup', { name: 'Экран: качество' });
    fireEvent.click(within(shown).getByRole('radio', { name: '1080p' }));
    expect(readPreferences().screen).toMatchObject({ resolution: 1080, fps: 30 });
    expect(screen.getByText('Ниже этого качества Cord не передаёт')).toBeInTheDocument();
    expect(screen.queryByText(/Этот сервер допускает/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /качество/ })).not.toBeInTheDocument();
    // Превью показа (R80) — то же поле, что в окне показа: preferences.screen.preview.
    const preview = screen.getByRole('switch', { name: 'Превью показа' });
    expect(preview).toBeChecked();
    fireEvent.click(preview);
    expect(readPreferences().screen.preview).toBe(false);
    // Ушли из раздела — камера отпущена.
    openSection('Микрофон');
    expect(device.stopped()).toBe(true);
  });

  it('«Видео»: камера недоступна — вместо превью объяснение, раздел работает', async () => {
    fakeCamera(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<Settings open section="video" onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Нет доступа к камере — разрешите его для Cord')).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Камера: качество' })).toBeInTheDocument();
  });

  it('закрытие окна отпускает камеру превью', async () => {
    const camera = fakeCamera();
    const { rerender } = render(<Settings open section="video" onOpenChange={vi.fn()} />);
    await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(1));
    rerender(<Settings open={false} section="video" onOpenChange={vi.fn()} />);
    await vi.waitFor(() => expect(camera.stopped()).toBe(true));
  });

  it('якорь слева ведёт к подразделу', () => {
    fakeCamera();
    render(<Settings open section="video" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Видео' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Демонстрация экрана' }));
    expect(screen.getByRole('radiogroup', { name: 'Экран: качество' })).toBeVisible();
  });

  it('щелчок по якорю подсвечивает его, и программная прокрутка к нему подсветку не затирает (R12)', async () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Микрофон' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Микрофон' }));
    // Ответ браузера на `scrollTop = …` — событие scroll; до scrollend пересчёта нет.
    fireEvent.scroll(document.querySelector('.settings-content')!);
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(within(anchors).getByRole('button', { name: 'Микрофон' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  /*
    R115: подсветка по прокрутке на настоящей разметке окна. Раскладки в jsdom нет — размеры области
    прокрутки и верхи групп подставляются, как их отдал бы браузер.
  */
  function layout({
    client,
    height,
    top,
    groups,
  }: {
    client: number;
    height: number;
    top: number;
    groups: number[];
  }) {
    const scroller = document.querySelector<HTMLElement>('.settings-content')!;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: client });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: height });
    scroller.scrollTop = top;
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    ['microphone', 'output'].forEach((anchor, index) => {
      const group = document.getElementById(`settings-anchor-${anchor}`)!;
      group.getBoundingClientRect = () => ({ top: groups[index]! - top }) as DOMRect;
    });
    return scroller;
  }
  /** Человек прокрутил: пауза после перехода по якорю снята, пересчёт — в ближайшем кадре. */
  async function scrolled(scroller: HTMLElement) {
    fireEvent(scroller, new Event('scrollend'));
    fireEvent.scroll(scroller);
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  }

  it('всё помещается без прокрутки — подсвечен выбранный щелчком, а не тот, что у линии (R115)', async () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Микрофон' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Динамики' }));
    // Окно выше раздела: «Динамики» начинаются ниже линии трети, «Микрофон» — у самого верха.
    const scroller = layout({ client: 760, height: 760, top: 0, groups: [0, 420] });
    await scrolled(scroller);
    expect(within(anchors).getByRole('button', { name: 'Динамики' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    fireEvent.click(within(anchors).getByRole('button', { name: 'Микрофон' }));
    await scrolled(scroller);
    expect(within(anchors).getByRole('button', { name: 'Микрофон' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  it('прокрутка у самого низа — последний подраздел, у верха — первый (R115)', async () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Микрофон' });
    // Низкое окно: раздел выше области на 40 px; у дна заголовок «Динамиков» ниже линии трети.
    const scroller = layout({ client: 460, height: 500, top: 40, groups: [0, 360] });
    await scrolled(scroller);
    expect(within(anchors).getByRole('button', { name: 'Динамики' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    layout({ client: 460, height: 500, top: 0, groups: [0, 360] });
    await scrolled(scroller);
    expect(within(anchors).getByRole('button', { name: 'Микрофон' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  it('поиск находит строку и открывает её раздел', () => {
    render(<Settings open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Найти настройку' }), {
      target: { value: 'токен' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Яндекс Музыка/ }));
    expect(heading()).toHaveTextContent('Аккаунты');
    expect(screen.getByRole('searchbox', { name: 'Найти настройку' })).toHaveValue('');
  });

  it('группы не сворачиваются (R16): заголовок — просто заголовок, строки всегда видны', () => {
    render(<Settings open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Найти настройку' }), {
      target: { value: 'клавиши кинозала' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Клавиши кинозала и игр/ }));
    expect(heading()).toHaveTextContent('Горячие клавиши');
    expect(screen.getByRole('heading', { name: 'Клавиши кинозала и игр', level: 3 })).toBeVisible();
    expect(screen.getByText('переставить комнату в избранном')).toBeVisible();
    // «Скрыть / раскрыть» нет нигде: ни у одной группы нет кнопки с aria-expanded.
    expect(document.querySelector('.settings-content [aria-expanded]')).toBeNull();
    expect(document.querySelector('.setting-group__toggle')).toBeNull();
  });
});

describe('«Аккаунты» (T33, R39)', () => {
  /** Служба: вход по коду устройства без встречи — код, «ждём», потом токен один раз. */
  function device(polls: { status: string; token?: string }[] = [{ status: 'pending' }]) {
    const auth = {
      id: 'device-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://ya.ru/device',
      expiresAt: Date.now() + 300000,
      interval: 0,
      status: 'pending',
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const body =
          url.endsWith('/services/yandex/device') && init?.method === 'POST'
            ? auth
            : init?.method === 'POST'
              ? { ...auth, ...(polls.shift() ?? { status: 'pending' }) }
              : { cancelled: true };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  it('Подключить → по QR-коду сразу: код, шаги и страница входа; токеном — вторая вкладка', async () => {
    device();
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    expect(screen.getByText('Telegram').closest('.setting-row')).toHaveTextContent('Скоро');
    fireEvent.click(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' }));
    expect(screen.getByRole('tab', { name: 'По QR-коду' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText('Наведите камеру телефона на QR-код')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Открыть страницу входа/ })).toHaveAttribute(
      'href',
      'https://ya.ru/device',
    );
    expect(await screen.findByRole('img', { name: 'QR-код страницы входа Яндекса' })).toBeInTheDocument();
  });

  it('подтвердили вход на телефоне — токен сохранён на устройстве, строка «Подключено»', async () => {
    device([{ status: 'pending' }, { status: 'connected', token: 'device-token-0123456789' }]);
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' }));
    expect(
      await screen.findByText('Подключено', { selector: '.ui-badge' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(readPreferences().yandexMusicToken).toBe('device-token-0123456789');
  });

  it('токеном → «Подключено» и «Сбросить»; где взять токен — шаги и страница Яндекса', () => {
    device();
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Токеном' }));
    const field = screen.getByLabelText('Токен Яндекс Музыки');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('maxlength', '1000');
    // «Токен хранится на этом устройстве и подставляется…» под полем больше нет — это в «Где взять токен».
    expect(screen.queryByText(/подставляется, когда вы добавляете/)).toBeNull();
    const howto = screen.getByText('Где взять токен').closest('details')!;
    expect(
      within(howto as HTMLElement).getByRole('link', { name: /Открыть страницу Яндекса/ }),
    ).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/oauth\.yandex\.ru\/authorize\?response_type=token&client_id=/),
    );
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '  fresh-token ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(readPreferences().yandexMusicToken).toBe('fresh-token');
    expect(screen.getByText('Подключено', { selector: '.ui-badge' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить: Яндекс Музыка' }));
    expect(readPreferences().yandexMusicToken).toBe('');
    expect(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' })).toBeInTheDocument();
  });

  it('«Отмена» во время входа по коду — код у службы отменяется', async () => {
    const calls = device();
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' }));
    await screen.findByText('ABCD-1234');
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' })).toBeInTheDocument();
    expect(calls).toContain('DELETE /api/v1/services/yandex/device/device-1');
  });

  it('сохранённый раньше токен виден как «Подключено» — данные не сбрасываются', () => {
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ yandexMusicToken: 'already-saved' }));
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Сбросить: Яндекс Музыка' })).toBeInTheDocument();
    expect(readPreferences().yandexMusicToken).toBe('already-saved');
  });
});

describe('«О программе»', () => {
  it('без строки «Автор» и ссылки на Telegram автора (R50): версия и обновления; поддержка — свой раздел (R51)', () => {
    render(<Settings open section="about" onOpenChange={vi.fn()} />);
    const body = document.querySelector('.settings-content')!;
    expect(body).not.toHaveTextContent(/Автор|nikgers|развивает/);
    expect(within(body as HTMLElement).queryByRole('link', { name: /Telegram/ })).toBeNull();
    for (const label of ['Версия', 'Приложение для Windows'])
      expect(within(body as HTMLElement).getByText(label)).toBeInTheDocument();
    expect(within(body as HTMLElement).queryByText('Помощь и поддержка')).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'Поддержка' })).toBeInTheDocument();
  });

  it('в браузере обновлять нечего: ни «Обновлений», ни «Проверить» — версия всегда последняя, приложение для Windows предлагается скачать (R132)', () => {
    render(<Settings open section="about" onOpenChange={vi.fn()} />);
    const body = document.querySelector('.settings-content') as HTMLElement;
    expect(within(body).queryByText('Обновления')).toBeNull();
    expect(within(body).queryByRole('button', { name: 'Проверить обновления' })).toBeNull();
    expect(body).toHaveTextContent('В браузере Cord всегда последней версии');
    expect(within(body).getByRole('link', { name: /Скачать/ })).toBeInTheDocument();
    expect(within(body).getByRole('button', { name: 'Пройти обучение' })).toBeInTheDocument();
  });
});

describe('профиль и оформление (T41)', () => {
  it('профиль устройства в шапке ведёт в «Профиль», имя сохраняется', () => {
    render(<Settings open section="about" onOpenChange={vi.fn()} />);
    fireEvent.click(within(nav()).getByRole('button', { name: /Без имени/ }));
    expect(heading()).toHaveTextContent('Профиль');
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя' }), { target: { value: 'Полина' } });
    expect(readPreferences().name).toBe('Полина');
    expect(within(nav()).getByRole('button', { name: /Полина/ })).toBeInTheDocument();
  });

  it('тема выбирается образцом в «Оформлении»; переключателя «Боты справа» нет — интеграции поверх звонка видны всегда (R21, R30)', () => {
    const setTheme = vi.fn();
    render(<Settings open section="appearance" theme="system" setTheme={setTheme} onOpenChange={vi.fn()} />);
    const themes = screen.getByRole('radiogroup', { name: 'Тема' });
    expect(within(themes).getByRole('radio', { name: 'Как в системе' })).toBeChecked();
    fireEvent.click(within(themes).getByRole('radio', { name: 'Тёмная' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(screen.queryByRole('switch', { name: 'Боты справа от встречи' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Во встрече' })).not.toBeInTheDocument();
  });

  it('язык выбирается в «Оформлении» самоназванием, запоминается и сразу меняет интерфейс (E14)', async () => {
    render(<Settings open section="appearance" onOpenChange={vi.fn()} />);
    const language = screen.getByRole('combobox', { name: 'Язык интерфейса' });
    expect(language).toHaveValue('');
    expect(within(language).getByRole('option', { name: 'Как в браузере' })).toBeInTheDocument();
    expect(within(language).getByRole('option', { name: 'English' })).toHaveAttribute('lang', 'en');
    fireEvent.change(language, { target: { value: 'en' } });
    expect(readPreferences().language).toBe('en');
    // Каталог английского приходит отдельным файлом и переведён целиком (E14-B).
    // Файл каталога — отдельный модуль: на занятой машине его первая загрузка в тестах идёт секунды.
    expect(await screen.findByRole('heading', { name: 'Language' }, { timeout: 30_000 })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(heading()).toHaveTextContent('Appearance');
    // «Как в браузере» сразу берёт язык браузера — он переведён, значит, интерфейс снова русский.
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru-RU']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), { target: { value: '' } });
    expect(readPreferences().language).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Язык' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
    vi.restoreAllMocks();
    await act(() => applyLanguage('ru'));
  });
});

describe('«Горячие клавиши» (T27)', () => {
  const record = (init: KeyboardEventInit) => {
    fireEvent.click(screen.getByRole('button', { name: 'Изменить сочетание микрофона' }));
    fireEvent.keyDown(document.querySelector('[data-hotkey-recorder]')!, init);
  };

  it('плашки «Работает поверх других программ…» нет — ни в браузере, ни в приложении (R22)', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/сочетания работают, только пока вкладка/)).not.toBeInTheDocument();
    expect(screen.queryByText(/поверх других программ/)).not.toBeInTheDocument();
  });

  it('второй щелчок по «Esc — отмена» отменяет запись, сочетание не меняется (R24)', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Изменить сочетание микрофона' }));
    expect(screen.getByText('Нажмите сочетание…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Esc — отмена записи сочетания' }));
    expect(screen.queryByText('Нажмите сочетание…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Изменить сочетание микрофона' })).toBeInTheDocument();
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
  });

  it('одна кнопка «Сбросить» вместо «По умолчанию» и «Отключить» (R25)', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    // По умолчанию сбрасывать нечего.
    expect(screen.queryByRole('button', { name: 'Сбросить сочетание микрофона' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Отключить/ })).not.toBeInTheDocument();
    record({ code: 'KeyJ', key: 'j', ctrlKey: true, altKey: true });
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyJ' });
    const reset = screen.getByRole('button', { name: 'Сбросить сочетание микрофона' });
    expect(reset).toHaveTextContent('Сбросить');
    fireEvent.click(reset);
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
    expect(screen.queryByRole('button', { name: 'Сбросить сочетание микрофона' })).not.toBeInTheDocument();
    // Кнопка исчезла — фокус не падает в никуда, а остаётся у сочетания.
    expect(screen.getByRole('button', { name: 'Изменить сочетание микрофона' })).toHaveFocus();
    cleanup();
    // Снятое раньше «Отключить» сочетание — «Назначить» и «Сбросить» к умолчанию.
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ micHotkey: null }));
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Назначить сочетание микрофона' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить сочетание микрофона' }));
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
  });

  it('не даёт назначить то, что забирает браузер, и предупреждает о плеере кинозала', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    record({ code: 'KeyW', key: 'w', ctrlKey: true });
    expect(screen.getByRole('alert')).toHaveTextContent('браузер оставляет себе');
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
    record({ code: 'Space', key: ' ' });
    expect(readPreferences().micHotkey).toMatchObject({ code: 'Space', ctrl: false });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/«пауза» в плеере кинозала/)).toBeInTheDocument();
    // Отказ не висит после того, как сочетание сменили другой кнопкой.
    record({ code: 'KeyT', key: 't', ctrlKey: true });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить сочетание микрофона' }));
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Esc отменяет запись, а модификаторы без клавиши её не заканчивают', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    record({ code: 'ControlLeft', key: 'Control', ctrlKey: true });
    expect(screen.getByText('Ctrl + …')).toBeInTheDocument();
    fireEvent.keyDown(document.querySelector('[data-hotkey-recorder]')!, { code: 'Escape', key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Изменить сочетание микрофона' })).toBeInTheDocument();
    expect(readPreferences().micHotkey?.code).toBe('KeyM');
  });

  it('в приложении честно говорит, где сочетание не сработает, и отпускает его на время записи', async () => {
    const postMessage = vi.fn();
    (window as { chrome?: unknown }).chrome = {
      webview: { postMessage, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.queryByText(/поверх других программ/)).not.toBeInTheDocument();
    record({ code: 'KeyJ', key: 'j', shiftKey: true });
    expect(screen.getByText(/только в окне Cord/)).toBeInTheDocument();
    // Пока шла запись, оболочке велели отпустить прежнее сочетание, а потом — взять новое, а не прежнее.
    await act(async () => {});
    const configure = postMessage.mock.calls
      .map(([message]) => message as { type: string; hotkey?: unknown })
      .filter((message) => message.type === 'hotkey.configure');
    expect(configure[0]).toMatchObject({ hotkey: null });
    expect(configure.at(-1)).toMatchObject({ hotkey: { code: 'KeyJ', shift: true } });
  });
});

describe('«Нажми и говори» и кнопки мыши (E01-B3, флаг ptt)', () => {
  function fakeV2(features: string[]) {
    const api = {
      protocol: { major: 2, minor: 0 },
      features,
      app: { version: '1.0.2', arch: 'x64' },
      bootstrap: {
        profile: 'x'.repeat(43),
        theme: 'system',
        showPing: false,
        notificationSounds: true,
        autoConnect: true,
      },
      send: vi.fn(),
      invoke: vi.fn(async () => null),
      on: vi.fn(() => () => {}),
    };
    (window as { cordDesktop?: unknown }).cordDesktop = api;
    return api;
  }
  afterEach(() => {
    delete (window as { cordDesktop?: unknown }).cordDesktop;
  });
  const change = () => screen.getByRole('button', { name: 'Изменить сочетание микрофона' });

  it('с флагом ptt — переключатель «Нажми и говори»: режим удержания хранится в профиле', async () => {
    fakeV2(['hotkeys', 'app.settings', 'ptt']);
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    const ptt = screen.getByRole('switch', { name: 'Нажми и говори' });
    expect(ptt).not.toBeChecked();
    fireEvent.click(ptt);
    await act(async () => {});
    expect(readPreferences().micHotkeyMode).toBe('hold');
    expect(screen.getByRole('switch', { name: 'Нажми и говори' })).toBeChecked();
    expect(screen.getByText('Удерживайте сочетание, чтобы говорить')).toBeInTheDocument();
  });

  it('без флага ptt и в браузере переключателя нет — поведение прежнее', () => {
    fakeV2(['hotkeys', 'app.settings']);
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('switch', { name: 'Нажми и говори' })).toBeNull();
    cleanup();
    delete (window as { cordDesktop?: unknown }).cordDesktop;
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('switch', { name: 'Нажми и говори' })).toBeNull();
  });

  it('«О программе» в приложении не спрашивает зеркало само — только по «Проверить»', () => {
    const api = fakeV2(['hotkeys', 'app.settings', 'update']);
    render(<Settings open section="about" onOpenChange={vi.fn()} />);
    const sent = () => api.send.mock.calls.map(([type]) => type);
    expect(api.invoke, 'состояние — то, что оболочка уже знает').toHaveBeenCalledWith('update.status');
    expect(sent()).not.toContain('update.check');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить обновления' }));
    expect(sent()).toContain('update.check');
  });

  it('с флагом ptt запись берёт боковую кнопку мыши; без флага — нет', async () => {
    fakeV2(['hotkeys', 'app.settings', 'ptt']);
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    fireEvent.click(change());
    fireEvent.mouseDown(document.body, { button: 3, ctrlKey: true });
    await act(async () => {});
    expect(readPreferences().micHotkey).toEqual({
      code: 'Mouse4',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    expect(screen.getByText('Кнопка мыши 4')).toBeInTheDocument();
    // Голая буква при Raw Input — предупреждение о наборе текста, а не «только в окне Cord».
    fireEvent.click(change());
    fireEvent.keyDown(document.querySelector('[data-hotkey-recorder]')!, { code: 'KeyV', key: 'v' });
    await act(async () => {});
    expect(screen.getByText(/набор/)).toBeInTheDocument();
    expect(screen.queryByText(/только в окне Cord/)).toBeNull();
    cleanup();
    localStorage.clear();
    fakeV2(['hotkeys', 'app.settings']);
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    fireEvent.click(change());
    fireEvent.mouseDown(document.body, { button: 3 });
    await act(async () => {});
    expect(readPreferences().micHotkey?.code).toBe('KeyM');
  });
});

describe('телефон: список разделов → раздел своим экраном', () => {
  it('без раздела открывается список; раздел — своим экраном с «назад»', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === '(max-width: 767px)',
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    render(<Settings open onOpenChange={vi.fn()} />);
    const window = screen.getByRole('dialog', { name: 'Настройки' });
    expect(window).toHaveAttribute('data-view', 'list');
    openSection('Звуки');
    expect(window).toHaveAttribute('data-view', 'section');
    expect(heading()).toHaveTextContent('Звуки');
    fireEvent.click(screen.getByRole('button', { name: 'К разделам' }));
    expect(window).toHaveAttribute('data-view', 'list');
  });
});
