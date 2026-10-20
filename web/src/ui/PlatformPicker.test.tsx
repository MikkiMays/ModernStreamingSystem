import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  it('выбранная отмечена; стрелки, Home и End переключают и несут фокус', () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <PlatformTabs label="Площадка" tiles={tiles} current="youtube" onPick={onPick} />,
    );
    const list = screen.getByRole('tablist', { name: 'Площадка' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'YouTube',
      'SoundCloud',
      'Яндекс Музыка',
      'Свои файлы',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[0]]);

    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(onPick).toHaveBeenLastCalledWith('soundcloud');
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(onPick).toHaveBeenLastCalledWith('upload');
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    expect(onPick).toHaveBeenLastCalledWith('upload');
    fireEvent.keyDown(tabs[3]!, { key: 'Home' });
    expect(onPick).toHaveBeenLastCalledWith('youtube');

    fireEvent.click(tabs[2]!);
    expect(onPick).toHaveBeenLastCalledWith('yandex');
    rerender(<PlatformTabs label="Площадка" tiles={tiles} current="yandex" onPick={onPick} />);
    expect(within(list).getByRole('tab', { name: 'Яндекс Музыка' })).toHaveAttribute('aria-selected', 'true');
  });
});
