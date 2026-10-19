import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences } from '../core/preferences';
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
    ).toEqual([
      'Микрофон',
      'Динамики',
      'Обработка звука',
      'Камера',
      'Демонстрация экрана',
      'Чужое видео',
      'Дополнительно',
    ]);
    openSection('О программе');
    expect(heading()).toHaveTextContent('О программе');
    expect(within(nav()).queryByRole('list', { name: /Подразделы/ })).not.toBeInTheDocument();
  });

  it('«Голос и видео»: устройства, громкость, проверка и качество из E05 в одном разделе', () => {
    render(<Settings open section="voice" onOpenChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Устройство ввода' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Громкость микрофона' })).toBeDisabled();
    expect(screen.getByRole('meter', { name: 'Уровень микрофона' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить', pressed: false })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('switch', { name: 'Уступать показу экрана' }));
    expect(readPreferences().cameraYieldsToScreen).toBe(true);
    // «Дополнительно» свёрнуто: по умолчанию буфер не трогают.
    expect(screen.getByRole('button', { name: 'Дополнительно', expanded: false })).toBeInTheDocument();
  });

  it('якорь слева раскрывает свёрнутый подраздел', () => {
    render(<Settings open section="voice" onOpenChange={vi.fn()} />);
    const anchors = within(nav()).getByRole('list', { name: 'Подразделы: Голос и видео' });
    fireEvent.click(within(anchors).getByRole('button', { name: 'Дополнительно' }));
    expect(screen.getByRole('button', { name: 'Дополнительно', expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Запас буфера приёма' })).toBeVisible();
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
});

describe('«Горячие клавиши» (T27)', () => {
  const record = (init: KeyboardEventInit) => {
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'По умолчанию' }));
    expect(readPreferences().micHotkey).toMatchObject({ code: 'KeyM', ctrl: true, shift: true });
  });

  it('Esc отменяет запись, а модификаторы без клавиши её не заканчивают', () => {
    render(<Settings open section="hotkeys" onOpenChange={vi.fn()} />);
    record({ code: 'ControlLeft', key: 'Control', ctrlKey: true });
    expect(screen.getByText('Ctrl + …')).toBeInTheDocument();
    fireEvent.keyDown(document.querySelector('[data-hotkey-recorder]')!, { code: 'Escape', key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Изменить' })).toBeInTheDocument();
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
    // Пока шла запись, оболочке велели отпустить прежнее сочетание, а потом — взять новое.
    await act(async () => {});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hotkey.configure', hotkey: null }),
    );
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
