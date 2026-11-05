import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { OwnCameraChip } from './OwnCameraChip';

afterEach(cleanup);

function meeting() {
  const cameraNote = new Store({ healing: false, backgroundOff: false });
  return { meeting: { media: { cameraNote } } as unknown as Pick<Meeting, 'media'>, cameraNote };
}

describe('метка своей камеры (R189, И6)', () => {
  it('молчит, пока камера здорова; говорит о лечении, потом о снятом фоне; лечение главнее', () => {
    const { meeting: m, cameraNote } = meeting();
    render(<OwnCameraChip meeting={m} />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => cameraNote.set({ healing: true, backgroundOff: false }));
    expect(screen.getByRole('status')).toHaveTextContent('Камера переподключается…');
    act(() => cameraNote.set({ healing: true, backgroundOff: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Камера переподключается…');
    act(() => cameraNote.set({ healing: false, backgroundOff: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Фон отключён');
    act(() => cameraNote.set({ healing: false, backgroundOff: false }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
