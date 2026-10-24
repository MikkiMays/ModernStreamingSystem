import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { MeetingSettings } from './MeetingSettings';

/*
  «Настройки встречи» (R53–R56, r103-30): без «Меняет только организатор…», интеграции —
  переключателем без «Громкость каждый всё равно ставит себе сам», «Кто может войти» — сегментом.
*/

afterEach(cleanup);

function fakeMeeting(integrationsAllowed = true) {
  return {
    snapshot: new Store({ title: 'Наша встреча', approvalRequired: false, integrationsAllowed }),
    api: {
      integrations: vi.fn(() => Promise.resolve()),
      settings: vi.fn(() => Promise.resolve()),
    },
    refresh: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & {
    api: { integrations: ReturnType<typeof vi.fn>; settings: ReturnType<typeof vi.fn> };
  };
}

const dialog = () => screen.getByRole('dialog', { name: 'Настройки встречи' });

describe('«Настройки встречи»', () => {
  it('без лишних пояснений (R54, R56) и без заголовка «Интеграции»', () => {
    render(<MeetingSettings meeting={fakeMeeting()} open onOpenChange={vi.fn()} />);
    expect(dialog()).not.toHaveTextContent('Меняет только организатор');
    expect(dialog()).not.toHaveTextContent('Остальные увидят это сразу');
    expect(dialog()).not.toHaveTextContent('Громкость каждый');
    expect(dialog()).not.toHaveTextContent(/галочк/i);
    expect(dialog()).not.toHaveAttribute('aria-describedby');
    expect(within(dialog()).queryByRole('heading', { name: 'Интеграции' })).toBeNull();
  });

  it('интеграции — переключатель, а не галочка (R55, X4)', () => {
    render(<MeetingSettings meeting={fakeMeeting()} open onOpenChange={vi.fn()} />);
    expect(within(dialog()).queryByRole('checkbox')).toBeNull();
    const integrations = within(dialog()).getByRole('switch', {
      name: /Разрешить интеграции всем участникам/,
    });
    expect(integrations).toBeChecked();
    expect(dialog()).toHaveTextContent('Иначе кинозал и музыку добавляете и убираете только вы.');
    fireEvent.click(integrations);
    expect(integrations).not.toBeChecked();
  });

  it('«Кто может войти» — сегмент из двух; под ним — что значит выбранное (R53)', () => {
    render(<MeetingSettings meeting={fakeMeeting()} open onOpenChange={vi.fn()} />);
    const access = within(dialog()).getByRole('radiogroup', { name: 'Кто может войти' });
    const open = within(access).getByRole('radio', { name: 'Сразу по ссылке' });
    const approval = within(access).getByRole('radio', { name: 'С подтверждения' });
    expect(open).toBeChecked();
    expect(dialog()).toHaveTextContent('Кто открыл приглашение, тот и вошёл.');
    fireEvent.click(approval);
    expect(approval).toBeChecked();
    expect(dialog()).toHaveTextContent('Каждый входящий ждёт, пока вы его впустите.');
    expect(dialog()).not.toHaveTextContent('Кто открыл приглашение, тот и вошёл.');
  });

  it('«Сохранить» выключена, пока ничего не поменялось; сохранение — обе ручки ядра и закрытие', async () => {
    const meeting = fakeMeeting();
    const onOpenChange = vi.fn();
    render(<MeetingSettings meeting={meeting} open onOpenChange={onOpenChange} />);
    const save = within(dialog()).getByRole('button', { name: 'Сохранить' });
    expect(save).toBeDisabled();
    expect(dialog()).not.toHaveTextContent('Ничего не поменялось');
    fireEvent.click(within(dialog()).getByRole('switch', { name: /Разрешить интеграции/ }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(meeting.api.integrations).toHaveBeenCalledWith(false);
    expect(meeting.api.settings).toHaveBeenCalledWith({ title: 'Наша встреча', approvalRequired: false });
  });
});
