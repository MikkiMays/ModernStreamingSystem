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
});

const nav = () => screen.getByRole('navigation', { name: 'Разделы настроек' });
const openSection = (name: string) => fireEvent.click(within(nav()).getByRole('button', { name }));
/** Заголовок открытого раздела справа (у окна есть и свой — «Настройки» слева). */
const heading = () => document.querySelector('.settings-content__title')!;

describe('окно настроек (T26)', () => {
  it('слева — разделы в группах, справа — открытый раздел; прежняя вкладка «audio» ведёт в «Голос и видео»', () => {
    render(<Settings open section="audio" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeInTheDocument();
    expect(heading()).toHaveTextContent('Голос и видео');
    expect(within(nav()).getByRole('button', { name: 'Голос и видео' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const group of ['Приложение', 'Встречи', 'Подключения'])
      expect(within(nav()).getByRole('heading', { name: group })).toBeInTheDocument();
    // Подразделы открытого раздела — якоря слева.
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Голос и видео' });
    expect(
      within(anchors)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Микрофон', 'Динамики', 'Обработка звука', 'Камера', 'Демонстрация экрана']);
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

  it('«Голос и видео»: устройства, громкость, проверка и качество из E05 в одном разделе', () => {
    render(<Settings open section="voice" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Устройство ввода' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Громкость микрофона' })).toBeDisabled();
    expect(screen.getByRole('meter', { name: 'Уровень микрофона' })).toBeInTheDocument();
    // У одинаковых на вид «Проверить» — разные имена для диктора.
    expect(screen.getByRole('button', { name: 'Проверить микрофон' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить динамики' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Показать превью камеры' })).toBeInTheDocument();
    // Качество — только из правил сервера: без «Авто» и без 1440p (E05).
    const camera = screen.getByRole('combobox', { name: 'Камера: качество' });
    expect(
      within(camera)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['720', '1080']);
    fireEvent.change(camera, { target: { value: '1080' } });
    expect(readPreferences().camera.resolution).toBe(1080);
    fireEvent.change(screen.getByRole('slider', { name: 'Громкость собеседников' }), {
      target: { value: '45' },
    });
    expect(readPreferences().outputVolume).toBe(45);
    // «Чужое видео», «Дополнительно» и «Уступать показу экрана» убраны (R06/R08): оптимум зашит.
    expect(screen.queryByRole('switch', { name: 'Уступать показу экрана' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Дополнительно' })).not.toBeInTheDocument();
  });

  it('якорь слева ведёт к подразделу', () => {
    render(<Settings open section="voice" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Голос и видео' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Демонстрация экрана' }));
    expect(screen.getByRole('combobox', { name: 'Экран: качество' })).toBeVisible();
  });

  it('щелчок по якорю подсвечивает его, и программная прокрутка к нему подсветку не затирает (R12)', async () => {
    render(<Settings open section="voice" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Голос и видео' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Динамики' }));
    // Ответ браузера на `scrollTop = …` — событие scroll; до scrollend пересчёта нет.
    fireEvent.scroll(document.querySelector('.settings-content')!);
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(within(anchors).getByRole('button', { name: 'Динамики' })).toHaveAttribute(
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

describe('«Аккаунты» (T33)', () => {
  it('Подключить → токен → «Подключено» и «Сбросить»; сброс возвращает «Подключить»', () => {
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    expect(screen.getByText('Telegram').closest('.setting-row')).toHaveTextContent('Скоро');
    fireEvent.click(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' }));
    const field = screen.getByLabelText('Токен Яндекс Музыки');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('maxlength', '1000');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '  fresh-token ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(readPreferences().yandexMusicToken).toBe('fresh-token');
    expect(screen.getByText('Подключено', { selector: '.ui-badge' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить: Яндекс Музыка' }));
    expect(readPreferences().yandexMusicToken).toBe('');
    expect(screen.getByRole('button', { name: 'Подключить: Яндекс Музыка' })).toBeInTheDocument();
  });

  it('сохранённый раньше токен виден как «Подключено» — данные не сбрасываются', () => {
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ yandexMusicToken: 'already-saved' }));
    render(<Settings open section="accounts" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Сбросить: Яндекс Музыка' })).toBeInTheDocument();
    expect(readPreferences().yandexMusicToken).toBe('already-saved');
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

  it('тема выбирается образцом в «Оформлении», боты справа — переключателем', () => {
    const setTheme = vi.fn();
    render(<Settings open section="appearance" theme="system" setTheme={setTheme} onOpenChange={vi.fn()} />);
    const themes = screen.getByRole('radiogroup', { name: 'Тема' });
    expect(within(themes).getByRole('radio', { name: 'Как в системе' })).toBeChecked();
    fireEvent.click(within(themes).getByRole('radio', { name: 'Тёмная' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
    fireEvent.click(screen.getByRole('switch', { name: 'Боты справа от встречи' }));
    expect(readPreferences().showIntegrationPanel).toBe(false);
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

  it('в браузере говорит, что сочетания работают только в активной вкладке', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(
      screen.getByText(
        'В браузере сочетания работают, только пока вкладка Cord активна. В приложении — всегда.',
      ),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'По умолчанию — сочетание микрофона' }));
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

  it('в приложении показывает ответ оболочки и честно говорит, где сочетание не сработает', async () => {
    const postMessage = vi.fn();
    (window as { chrome?: unknown }).chrome = {
      webview: { postMessage, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    expect(screen.getByText('В приложении сочетание работает и поверх других программ.')).toBeInTheDocument();
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
