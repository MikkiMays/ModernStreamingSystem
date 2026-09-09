import { expect, test } from '@playwright/test';
import type { Admission, Attachment } from '../src/api/types';

test('tus resumes at the acknowledged offset and enforces ownership', async ({ request }) => {
  const created = await request.post('/api/v1/rooms', {
    data: {
      commandId: crypto.randomUUID(),
      title: 'Проверка загрузки',
      name: 'Хост',
      approvalRequired: false,
    },
  });
  expect(created.ok()).toBe(true);
  const host = (await created.json()) as Admission;
  const headers = { Authorization: `Bearer ${host.credential}` };
  try {
    const guestReply = await request.post(`/api/v1/rooms/${host.roomId}/join`, {
      data: { commandId: crypto.randomUUID(), invite: host.inviteUrl!.split('invite=')[1], name: 'Гость' },
    });
    const guest = (await guestReply.json()) as Admission;
    const reserved = await request.post(`/api/v1/rooms/${host.roomId}/attachments`, {
      headers,
      data: { commandId: crypto.randomUUID(), name: 'resume.txt', size: 12 },
    });
    expect(reserved.ok()).toBe(true);
    const file = (await reserved.json()) as Attachment;
    const tusHeaders = {
      ...headers,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': '12',
      'Upload-Metadata': `attachmentId ${Buffer.from(file.id).toString('base64')}`,
    };
    const upload = await request.post('/uploads/', { headers: tusHeaders });
    expect(upload.status()).toBe(201);
    const url = new URL(upload.headers().location!, 'http://localhost:5173').pathname;
    const stranger = await request.head(url, {
      headers: { Authorization: `Bearer ${guest.credential}`, 'Tus-Resumable': '1.0.0' },
    });
    expect(stranger.status()).toBe(403);
    const patchHeaders = {
      ...headers,
      'Tus-Resumable': '1.0.0',
      'Content-Type': 'application/offset+octet-stream',
    };
    expect(
      (
        await request.patch(url, {
          headers: { ...patchHeaders, 'Upload-Offset': '0' },
          data: Buffer.from('Hello '),
        })
      ).status(),
    ).toBe(204);
    const offset = await request.head(url, { headers: { ...headers, 'Tus-Resumable': '1.0.0' } });
    expect(offset.headers()['upload-offset']).toBe('6');
    expect(
      (
        await request.patch(url, {
          headers: { ...patchHeaders, 'Upload-Offset': '6' },
          data: Buffer.from('world!'),
        })
      ).status(),
    ).toBe(204);
    await expect
      .poll(async () => {
        const result = await request.get(`/api/v1/attachments/${file.id}/content`, {
          headers: { Authorization: `Bearer ${guest.credential}` },
        });
        return result.status();
      })
      .toBe(200);
    const result = await request.get(`/api/v1/attachments/${file.id}/content`, { headers });
    expect(await result.text()).toBe('Hello world!');
    expect(result.headers()['content-disposition']).toContain('attachment');
    expect((await request.get(url, { headers })).status()).toBe(403);
  } finally {
    await request.post(`/api/v1/rooms/${host.roomId}/commands`, {
      headers,
      data: { commandId: crypto.randomUUID(), type: 'close' },
    });
  }
});
