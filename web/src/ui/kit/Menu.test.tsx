import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Zap } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import kit from './kit.css?raw';
import { Menu, MenuContent, MenuItem, MenuSubmenu, MenuSwitchItem, MenuTrigger } from './Menu';

afterEach(cleanup);

function RoomMenu({ onChange = () => {} }: { onChange?: (value: boolean) => void }) {
  const [auto, setAuto] = useState(false);
  return (
    <Menu defaultOpen>
      <MenuTrigger>Действия</MenuTrigger>
      <MenuContent>
        <MenuItem>Переименовать</MenuItem>
        <MenuSwitchItem
          icon={<Zap />}
          checked={auto}
          onCheckedChange={(value) => {
            setAuto(value);
            onChange(value);
          }}
        >
          Автоподключение
        </MenuSwitchItem>
        <MenuSubmenu label="Группа">
          <MenuItem>Без группы</MenuItem>
        </MenuSubmenu>
      </MenuContent>
    </Menu>
  );
}

describe('MenuSwitchItem', () => {
  it('пункт-переключатель: роль menuitemcheckbox и aria-checked (e2e держатся за роль)', async () => {
    render(<RoomMenu />);
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Автоподключение' });
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveClass('ui-menu__item', 'ui-menu__item--switch');
  });

  it('щелчок переключает, а меню остаётся открытым', async () => {
    const onChange = vi.fn();
    render(<RoomMenu onChange={onChange} />);
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Автоподключение' });
    fireEvent.click(item);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(item);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('состояние видно переключателем в третьей колонке: он не интерактивен и скрыт от диктора', async () => {
    render(<RoomMenu />);
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Автоподключение' });
    const track = item.querySelector('.ui-switch');
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track?.tagName).toBe('SPAN');
    expect(item.querySelector('.ui-menu__icon svg')).toHaveClass('lucide-zap');
    expect(kit).toMatch(
      /\.ui-menu__item\[data-checked\] \.ui-switch--menu \{\s*background: var\(--accent-fill\);/,
    );
  });
});

describe('MenuSubmenu', () => {
  it('стрелка подменю — значок, а не символ «›»', async () => {
    render(<RoomMenu />);
    const trigger = await screen.findByRole('menuitem', { name: 'Группа' });
    expect(trigger.textContent).not.toContain('›');
    expect(trigger.querySelector('.ui-menu__chevron svg')).toHaveClass('lucide-chevron-right');
  });
});
