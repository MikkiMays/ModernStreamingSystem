import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { t } from '../i18n';
import { platformTiles } from './music-platforms';
import { PlatformPicker, PlatformTabs } from './PlatformPicker';

/*
  Экран выбора площадки — общий у кинозала и музыки (T59): плитки, «Последний выбор», фокус при
  входе; и вкладки площадок над музыкой.
*/

afterEach(cleanup);

const tiles = platformTiles(t, ['youtube', 'soundcloud', 'yandex', 'upload']);

const picker = (patch: Partial<Parameters<typeof PlatformPicker>[0]> = {}) => {
  const props = {
    title: 'Музыка',
    backLabel: 'Интеграции',
    onBack: vi.fn(),
    label: 'Площадки музыки',
    tiles,
    last: null,
    onPick: vi.fn(),
    ...patch,
  };
  render(<PlatformPicker {...props} />);
  return props;
};

const group = () => screen.getByRole('group', { name: 'Площадки музыки' });
const tile = (name: string) => within(group()).getByRole('button', { name: new RegExp(`^${name}`) });

describe('экран выбора площадки', () => {
  it('плитки в порядке реестра, у каждой строка «что там»; выбор и «назад»', () => {
    const props = picker();
    expect(screen.getByRole('heading', { name: 'Музыка' })).toBeInTheDocument();
    expect(screen.getByText('Выберите площадку')).toBeInTheDocument();
    const buttons = within(group()).getAllByRole('button');
    expect(buttons.map((button) => button.querySelector('b')?.textContent)).toEqual([
      'YouTube',
      'SoundCloud',
      'Яндекс Музыка',
      'Свои файлы',
    ]);
    expect(buttons.every((button) => button.querySelector('small')?.textContent)).toBe(true);
    fireEvent.click(tile('SoundCloud'));
    expect(props.onPick).toHaveBeenCalledWith('soundcloud');
    fireEvent.click(screen.getByRole('button', { name: 'Интеграции' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('прошлый выбор отмечен, и фокус при входе — на нём', () => {
    picker({ last: 'yandex' });
    expect(within(tile('Яндекс Музыка')).getByText('Последний выбор')).toBeInTheDocument();
    expect(screen.getAllByText('Последний выбор')).toHaveLength(1);
    expect(tile('Яндекс Музыка')).toHaveFocus();
  });

  it('без прошлого выбора фокус — на первой доступной; незнакомое имя ничего не отмечает', () => {
    picker({ last: 'telegram', tiles: tiles.map((item, index) => ({ ...item, disabled: index === 0 })) });
    expect(screen.queryByText('Последний выбор')).toBeNull();
    expect(tile('YouTube')).toBeDisabled();
    expect(tile('SoundCloud')).toHaveFocus();
  });

  it('витрина набора фокус страницы не забирает', () => {
    picker({ last: 'yandex', focusOnEnter: false });
    expect(tile('Яндекс Музыка')).not.toHaveFocus();
  });

  it('что идёт сейчас — над плитками', () => {
    picker({ now: <p>Сейчас играет: Трек</p> });
    expect(screen.getByText('Сейчас играет: Трек').closest('.platform-picker__now')).not.toBeNull();
  });
});

describe('вкладки площадок', () => {
  it('выбранная отмечена; стрелки, Home и End переключают и несут фокус', async () => {
    // Вкладки — переключатель набора (`Tabs segmented sm`, R128): подпись короткая, имя — полное.
    const onPick = vi.fn();
    // Площадку держит владелец вкладок, как плеер (`useMusic`): выбор возвращается в `current`.
    function Owner() {
      const [current, setCurrent] = useState<(typeof tiles)[number]['id']>('youtube');
      return (
        <PlatformTabs
          label="Площадка"
          tiles={tiles}
          current={current}
          onPick={(id) => {
            setCurrent(id);
            onPick(id);
          }}
        />
      );
    }
    render(<Owner />);
    const list = screen.getByRole('tablist', { name: 'Площадка' });
    const tabs = within(list).getAllByRole('tab');
    // Полное имя — у вкладки для диктора, на ней самой — короткое, если задано (R128).
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'YouTube',
      'SoundCloud',
      'Яндекс Музыка',
      'Свои файлы',
    ]);
    expect(tabs.map((tab) => tab.textContent)).toEqual(['YouTube', 'SoundCloud', 'Яндекс', 'Файлы']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[0]]);

    // Стрелки ходят от вкладки в фокусе и сразу выбирают её (`activateOnFocus`), по кругу. Фокус
    // Base UI переводит следующей микрозадачей — выбор идёт за ним.
    const press = async (key: string, tab: number, id: string) => {
      fireEvent.keyDown(document.activeElement!, { key });
      await waitFor(() => expect(tabs[tab]).toHaveFocus());
      expect(onPick).toHaveBeenLastCalledWith(id);
    };
    act(() => tabs[0]!.focus());
    await press('ArrowRight', 1, 'soundcloud');
    await press('ArrowLeft', 0, 'youtube');
    await press('ArrowLeft', 3, 'upload');
    await press('Home', 0, 'youtube');
    await press('End', 3, 'upload');

    fireEvent.click(tabs[2]!);
    expect(onPick).toHaveBeenLastCalledWith('yandex');
    expect(within(list).getByRole('tab', { name: 'Яндекс Музыка' })).toHaveAttribute('aria-selected', 'true');
  });
});
