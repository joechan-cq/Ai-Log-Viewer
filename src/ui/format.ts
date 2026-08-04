export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function fmtMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (m < 60) return `${m}m${s}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/**
 * 耗时的视觉分档。阈值按数量级（1s / 10s / 60s）而不是单位边界切 ——
 * 900ms 和 1.1s 本质是一回事，按 ms/s/m 切会让它们跳两个色阶。
 * 快的那档保持灰色：正常速度不该抢注意力。
 */
export function durTone(ms?: number): 'fast' | 'mid' | 'slow' | 'vslow' | 'none' {
  if (ms == null || !Number.isFinite(ms)) return 'none'
  if (ms < 1000) return 'fast'
  if (ms < 10_000) return 'mid'
  if (ms < 60_000) return 'slow'
  return 'vslow'
}

/**
 * 间隔标记的分档。间隔本身已经过滤掉 10s 以下的，
 * 若直接套用 durTone（1s/10s/60s）就只剩橙和红两档，看不出递进，
 * 所以把阈值整体上移到 30s / 60s / 5min，让三档都用得上。
 */
export function gapTone(ms: number): 'mid' | 'slow' | 'vslow' {
  if (ms < 30_000) return 'mid'
  if (ms < 60_000) return 'slow'
  return 'vslow'
}

export function fmtNum(n?: number): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function fmtDateTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
