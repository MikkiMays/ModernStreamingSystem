import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatsOf, withChat } from './alerts-chat.mjs';

test('чаты берутся из сообщений, записей канала и добавления бота — без повторов', () => {
  const chats = chatsOf([
    { message: { chat: { id: 42, type: 'private' } } },
    { message: { chat: { id: 42, type: 'private' } } },
    { my_chat_member: { chat: { id: -1001, type: 'supergroup' } } },
    { channel_post: { chat: { id: -1002, type: 'channel' } } },
    { edited_message: {} },
  ]);
  assert.deepEqual(chats, [
    { id: 42, type: 'private' },
    { id: -1001, type: 'supergroup' },
    { id: -1002, type: 'channel' },
  ]);
  assert.deepEqual(chatsOf(undefined), []);
});

test('новый чат заменяет прежнюю строку и не трогает токен и комментарии', () => {
  const before = '# бот оповещений\nALERT_TELEGRAM_BOT_TOKEN=1:abc\nALERT_TELEGRAM_CHAT_ID=7\n';
  assert.equal(withChat(before, 42), '# бот оповещений\nALERT_TELEGRAM_BOT_TOKEN=1:abc\nALERT_TELEGRAM_CHAT_ID=42\n');
  assert.equal(withChat('ALERT_TELEGRAM_BOT_TOKEN=1:abc\n', -100), 'ALERT_TELEGRAM_BOT_TOKEN=1:abc\nALERT_TELEGRAM_CHAT_ID=-100\n');
});
