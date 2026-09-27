import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { safeLocalStorage } from '@/utils/safeStorage';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'sdi:theme';

/** Token names resolved from CSS variables for libraries that need real colours. */
const TOKENS = [
  'brand',
  'ok',
  'warn',
  'danger',
  'info',
  'violet',
  'line',
  'ink',
  'muted',
  'faint',
  'canvas',
  'surface',
  'elevated',
] as const;

export type ColorToken = (typeof TOKENS)[number];
export type ThemeColors = Record<ColorToken, string>;

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  /** Concrete rgb() strings - SVG presentation attributes cannot read var(). */
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = safeLocalStorage.get(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const entries = TOKENS.map((token) => {
    const raw = style.getPropertyValue(`--c-${token}`).trim();
    return [token, raw ? `rgb(${raw})` : '#64748b'] as const;
  });
  return Object.fromEntries(entries) as ThemeColors;
}

const FALLBACK: ThemeColors = {
  brand: '#38bdf8',
  ok: '#34d399',
  warn: '#fbbf24',
  danger: '#fb7185',
  info: '#818cf8',
  violet: '#c084fc',
  line: '#1f2b42',
  ink: '#e2e8f0',
  muted: '#94a3b8',
  faint: '#7a89a0',
  canvas: '#070b14',
  surface: '#0d1422',
  elevated: '#121a2b',
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [colors, setColors] = useState<ThemeColors>(FALLBACK);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    safeLocalStorage.set(STORAGE_KEY, theme);
    // Read after the class change so charts pick up the new palette. The values
    // only exist in the DOM once the class is applied, hence state set in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColors(readColors());
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(() => setThemeState((current) => (current === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ theme, setTheme, toggle, colors }), [theme, setTheme, toggle, colors]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}

export const useThemeColors = () => useTheme().colors;
