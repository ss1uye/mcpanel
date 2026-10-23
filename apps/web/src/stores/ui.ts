import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'mcpanel_theme';

export function storedTheme(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark';
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

interface UiStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useUi = create<UiStore>((set) => ({
  theme: storedTheme(),
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
}));

applyTheme(storedTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (useUi.getState().theme === 'system') applyTheme('system');
});
