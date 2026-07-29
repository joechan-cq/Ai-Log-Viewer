import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { ImageRef } from '../model/types'

const MIN_PCT = 0.1
const MAX_PCT = 8
const STEP = 1.25

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * 图片查看：缩放按「相对原始像素的百分比」算，100% 就是 1:1。
 * 手机截图（480×1071 这类）适应窗口后往往不到原始尺寸，
 * 所以需要能真正放大到 200%~400% 去看小字，而不只是 fit / 1:1 两档。
 */
export function ImageView({ img }: { img: ImageRef }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  /** 适应窗口时的比例，作为「适应」按钮和初始值 */
  const [fit, setFit] = useState(1)
  /** null = 跟随 fit（窗口变化时自动重算） */
  const [pct, setPct] = useState<number | null>(null)

  const measure = useCallback(() => {
    const el = wrapRef.current
    if (!el || !nat) return
    const pad = 24
    setFit(clamp(Math.min((el.clientWidth - pad) / nat.w, (el.clientHeight - pad) / nat.h), MIN_PCT, MAX_PCT))
  }, [nat])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const scale = pct ?? fit
  const zoomTo = (next: number) => setPct(clamp(next, MIN_PCT, MAX_PCT))

  // 放大后拖拽平移
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const onPointerDown = (e: PointerEvent) => {
    const el = wrapRef.current
    if (!el) return
    drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    const el = wrapRef.current
    const d = drag.current
    if (!el || !d) return
    el.scrollLeft = d.sl - (e.clientX - d.x)
    el.scrollTop = d.st - (e.clientY - d.y)
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const style = nat ? { width: `${Math.round(nat.w * scale)}px`, height: `${Math.round(nat.h * scale)}px` } : undefined

  return (
    <div class="imgview">
      <div
        class={`img-wrap ${scale > fit ? 'pannable' : ''}`}
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          class="modal-img"
          src={`data:${img.mediaType};base64,${img.data}`}
          style={style}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget
            setNat({ w: el.naturalWidth, h: el.naturalHeight })
          }}
        />
      </div>

      <div class="zoombar">
        <button class="btn icon" title="缩小" onClick={() => zoomTo(scale / STEP)}>
          −
        </button>
        <span class="zoom-pct mono" title={nat ? `${nat.w} × ${nat.h} 原始像素` : ''}>
          {Math.round(scale * 100)}%
        </span>
        <button class="btn icon" title="放大" onClick={() => zoomTo(scale * STEP)}>
          +
        </button>
        <button class="btn" onClick={() => setPct(null)}>
          适应
        </button>
        <button class="btn" onClick={() => zoomTo(1)}>
          1:1
        </button>
        {nat && (
          <span class="dim small mono">
            {nat.w}×{nat.h}
          </span>
        )}
      </div>
    </div>
  )
}
