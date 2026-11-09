import { Store } from '../core/store';

/** Тема пульта: как у системы, светлая или тёмная. Ключ тот же, что у приложения, но хранилище — имени пульта. */
export type AdminTheme = 'system' | 'light' | 'dark';

const KEY = 'cord:theme';

export function readTheme(): AdminTheme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export const adminTheme = new Store<AdminTheme>(readTheme());

export function setAdminTheme(theme: AdminTheme) {
  adminTheme.set(theme);
  document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* Приватное окно: тема живёт до перезагрузки. */
  }
}
