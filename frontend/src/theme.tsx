import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { load, save } from './storage'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

const ThemeContext = createContext<{ choice: ThemeChoice; theme: Theme; setChoice: (c: ThemeChoice) => void } | null>(null)

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const resolve = (choice: ThemeChoice, system: Theme): Theme => (choice === 'system' ? system : choice)

// Applied synchronously, before React re-renders: the 3D scenes read CSS variables while
// rendering (palette.ts), so the class must already match the new theme by then.
function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0e2350' : '#e6e9e4')
}

/** Light is drafting film, dark is the cyanotype of the same drawing. index.html applies it before paint. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => load('theme', 'system'))
  const [system, setSystem] = useState<Theme>(systemTheme)
  const theme = resolve(choice, system)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const next: Theme = mq.matches ? 'dark' : 'light'
      if (load<ThemeChoice>('theme', 'system') === 'system') apply(next)
      setSystem(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setChoice = (c: ThemeChoice) => {
    apply(resolve(c, system))
    save('theme', c)
    setChoiceState(c)
  }
  return <ThemeContext.Provider value={{ choice, theme, setChoice }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
