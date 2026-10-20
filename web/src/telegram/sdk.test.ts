import { emitEvent, mockTelegramEnv } from '@tma.js/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { startTelegram } from './sdk';

const RAW =
  'auth_date=1760000000&hash=89d6079ad6762351f38c6dbbc41bb53048019256a9443988af7a48bcad16ba31' +
  '&signature=6fbdaab833d39f54518bd5c3eb3f511d035e68cb' +
  '&user=%7B%22id%22%3A5%2C%22first_name%22%3A%22Ivan%22%7D&start_param=bLink&chat_type=supergroup' +
  '&chat_instance=-42';

/**
 * Что Mini App говорит Telegram при запуске — через подменённый мост SDK (`mockTelegramEnv`), без
 * настоящего клиента. Ответы клиента на запросы зон и окна приходят событиями, как у Telegram.
 */
function launch(platform: string) {
  const calls: { name: string; params: unknown }[] = [];
  mockTelegramEnv({
    resetPostMessage: true,
    launchParams: {
      tgWebAppPlatform: platform,
      tgWebAppVersion: '9.1',
      tgWebAppData: RAW,
      tgWebAppStartParam: 'bLink',
      tgWebAppThemeParams: { bg_color: '#212d3b', text_color: '#ffffff', button_color: '#2481cc' },
    },
    onEvent: (event) => {
      calls.push(event);
      const reply = () => {
        if (event.name === 'web_app_request_viewport')
          emitEvent('viewport_changed', {
            height: 800,
            width: 390,
            is_expanded: true,
            is_state_stable: true,
          });
        if (event.name === 'web_app_request_safe_area')
          emitEvent('safe_area_changed', { top: 47, bottom: 34, left: 0, right: 0 });
        if (event.name === 'web_app_request_content_safe_area')
          emitEvent('content_safe_area_changed', { top: 46, bottom: 0, left: 0, right: 0 });
        if (event.name === 'web_app_request_fullscreen')
          emitEvent('fullscreen_changed', { is_fullscreen: true });
      };
      setTimeout(reply, 0);
    },
  });
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('запуск Mini App (sdk.ts)', () => {
  afterEach(() => {
    sessionStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('вне Telegram оболочки нет', () => {
    expect(startTelegram()).toBeNull();
  });

  it('на телефоне: цвета до ready(), свайп выключен, окно развёрнуто, полный экран, зоны в CSS', async () => {
    const calls = launch('ios');
    const shell = startTelegram();
    expect(shell?.initData).toBe(RAW);
    expect(shell?.platform).toBe('ios');
    const names = () => calls.map((call) => call.name);
    expect(names()).toContain('web_app_ready');
    expect(names().indexOf('web_app_set_header_color')).toBeLessThan(names().indexOf('web_app_ready'));
    expect(calls).toContainEqual({ name: 'web_app_set_header_color', params: { color: '#212d3b' } });
    expect(calls).toContainEqual({
      name: 'web_app_setup_swipe_behavior',
      params: { allow_vertical_swipe: false },
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await settle();
    expect(names()).toContain('web_app_expand');
    expect(names()).toContain('web_app_request_fullscreen');
    expect(document.documentElement.style.getPropertyValue('--tg-inset-top')).toBe('93px');
    expect(document.documentElement.style.getPropertyValue('--tg-inset-bottom')).toBe('34px');
  });

  it('на Desktop полного экрана не просит; «Назад», отклик и подтверждение закрытия — по просьбе', async () => {
    const calls = launch('tdesktop');
    const shell = startTelegram()!;
    await settle();
    expect(calls.map((call) => call.name)).not.toContain('web_app_request_fullscreen');
    shell.back(() => {});
    shell.haptic('success');
    shell.confirmClosing(true);
    shell.back(null);
    expect(calls).toContainEqual({ name: 'web_app_setup_back_button', params: { is_visible: true } });
    expect(calls).toContainEqual({ name: 'web_app_setup_back_button', params: { is_visible: false } });
    expect(calls).toContainEqual({
      name: 'web_app_trigger_haptic_feedback',
      params: { type: 'notification', notification_type: 'success' },
    });
    expect(calls).toContainEqual({
      name: 'web_app_setup_closing_behavior',
      params: { need_confirmation: true },
    });
  });
});
