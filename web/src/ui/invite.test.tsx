import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { Invite } from './Invite';

afterEach(cleanup);

/*
  QR-код приглашения — рисунком (SVG), а не PNG в 256 px: на телефоне с плотностью 2–3 растр
  растягивался и мылился (аудит чёткости E15-B на 360), а камера читает код по резким краям.
*/
it('QR-код приглашения — векторный рисунок со ссылкой встречи', async () => {
  const meeting = {
    admission: { participantId: 'self', roomId: 'room' },
    invite: new Store<string | null>(null),
    snapshot: new Store({ code: '449853989', participants: [{ id: 'self', owner: true }] }),
  } as unknown as Meeting;
  render(<Invite meeting={meeting} open onOpenChange={() => {}} />);
  const qr = await screen.findByRole('img', { name: 'QR-код приглашения во встречу' });
  const src = qr.getAttribute('src')!;
  expect(src.startsWith('data:image/svg+xml')).toBe(true);
  const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
  expect(svg).toContain('<svg');
  expect(svg).toContain('shape-rendering="crispEdges"');
});
