import { beforeEach, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { alreadyInMeeting, entryHeaders, PROFILE_KEY, profileSecret } from './identity';

beforeEach(() => localStorage.clear());

it('профиль устройства — один секрет на браузер: создаётся раз и дальше не меняется', () => {
  const secret = profileSecret();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(localStorage.getItem(PROFILE_KEY)).toBe(secret);
  expect(profileSecret()).toBe(secret);
});

it('сохранённый секрет берётся как есть, испорченный заменяется новым', () => {
  const saved = 'A'.repeat(43);
  localStorage.setItem(PROFILE_KEY, saved);
  expect(profileSecret()).toBe(saved);
  localStorage.setItem(PROFILE_KEY, 'не секрет');
  expect(profileSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(profileSecret()).not.toBe('не секрет');
});

it('вход несёт профиль, а «выйти оттуда и войти сюда» — ещё и встречу, которую покидают', () => {
  expect(entryHeaders()).toEqual({ 'X-Cord-Profile': profileSecret() });
  expect(entryHeaders('6c01abcf-2831-466e-8231-f228ab067bf2')).toEqual({
    'X-Cord-Profile': profileSecret(),
    'X-Cord-Leave': '6c01abcf-2831-466e-8231-f228ab067bf2',
  });
});

it('отказ «вы уже во встрече» узнаётся по коду и несёт её адрес и название', () => {
  const refusal = new ApiError(409, 'ALREADY_IN_MEETING', 'Вы уже во встрече «Вечер»', {
    roomId: 'room-1',
    title: 'Вечер',
  });
  expect(alreadyInMeeting(refusal)).toEqual({ roomId: 'room-1', title: 'Вечер' });
  // Чужой отказ, отказ без подробностей и не отказ вовсе — не этот случай.
  expect(alreadyInMeeting(new ApiError(409, 'ROOM_FULL', 'Мест нет'))).toBeNull();
  expect(alreadyInMeeting(new ApiError(409, 'ALREADY_IN_MEETING', 'Вы уже во встрече'))).toBeNull();
  expect(alreadyInMeeting(new Error('сеть'))).toBeNull();
  expect(alreadyInMeeting(undefined)).toBeNull();
});
