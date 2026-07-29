export type Theme = 'system' | 'light' | 'dark'

const KEY = 'alf.theme'
const THEME_COLOR: Record<'light' | 'dark', string> = { light: '#f7f8fa', dark: '#0d0f14' }

export function loadTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

export function saveTheme(t: Theme) {
  localStorage.setItem(KEY, t)
}

export function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t !== 'system') return t
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** CSS 只认 data-theme，所以这里始终把 system 解析成具体值再落到 <html> 上 */
export function applyTheme(t: Theme) {
  const resolved = resolveTheme(t)
  document.documentElement.dataset.theme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
}

/** 跟随系统时监听系统切换；返回取消订阅函数 */
export function watchSystem(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

export const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
export const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' }
export const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' }
