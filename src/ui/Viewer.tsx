import { useEffect, useMemo, useState } from 'preact/hooks'
import type { ImageRef } from '../model/types'
import { escapeHtml, highlight, renderMarkdown, stripLineNumbers } from './markdown'
import { ImageView } from './ImageView'

export interface ViewerPayload {
  title: string
  /** 文本模式 */
  text?: string
  lang?: string
  /** 可用 markdown 渲染（AI 回复、子 agent 返回这类） */
  markdown?: boolean
  /** 图片模式：整组图片 + 当前下标，支持左右切换 */
  images?: { list: ImageRef[]; index: number }
}

/** 超过这个长度就不做整体语法高亮（几百 KB 的一次性高亮会明显卡顿） */
const HIGHLIGHT_LIMIT = 150_000
/** 分块渲染的块大小，配合 content-visibility 让屏外块不参与排版 */
const CHUNK = 40_000

let listener: ((p: ViewerPayload | null) => void) | null = null

/** 任意组件都能拉起全屏查看器，不用把 state 往上提 */
export function openViewer(p: ViewerPayload) {
  listener?.(p)
}

export function ViewerHost() {
  const [payload, setPayload] = useState<ViewerPayload | null>(null)
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imgIndex, setImgIndex] = useState(0)

  useEffect(() => {
    listener = (p) => {
      setPayload(p)
      setRaw(false)
      setCopied(false)
      setImgIndex(p?.images?.index ?? 0)
    }
    return () => {
      listener = null
    }
  }, [])

  const list = payload?.images?.list
  useEffect(() => {
    if (!payload) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPayload(null)
      if (!list || list.length < 2) return
      if (e.key === 'ArrowRight') setImgIndex((i) => (i + 1) % list.length)
      if (e.key === 'ArrowLeft') setImgIndex((i) => (i - 1 + list.length) % list.length)
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [payload, list])

  if (!payload) return null
  const { title, text, lang, markdown } = payload
  const img = list?.[imgIndex]
  const asMarkdown = !!markdown && !raw

  return (
    <div class="modal-back" onClick={() => setPayload(null)}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <header class="modal-head">
          <span class="modal-title">{title}</span>

          {img ? (
            <>
              <span class="dim small">
                {img.mediaType} · {Math.round((img.data.length * 3) / 4 / 1024).toLocaleString()} KB
                {list && list.length > 1 ? ` · ${imgIndex + 1}/${list.length}` : ''}
              </span>
              <span class="spacer" />
              {list && list.length > 1 && (
                <>
                  <button class="btn icon" title="上一张 (←)" onClick={() => setImgIndex((i) => (i - 1 + list.length) % list.length)}>
                    ‹
                  </button>
                  <button class="btn icon" title="下一张 (→)" onClick={() => setImgIndex((i) => (i + 1) % list.length)}>
                    ›
                  </button>
                </>
              )}
              <a class="btn" href={`data:${img.mediaType};base64,${img.data}`} download={fileName(title, img.mediaType)}>
                下载
              </a>
            </>
          ) : (
            <>
              <span class="dim small">{(text?.length ?? 0).toLocaleString()} 字符</span>
              <span class="spacer" />
              {markdown && (
                <div class="tabs">
                  <button class={`tab ${!raw ? 'active' : ''}`} onClick={() => setRaw(false)}>
                    渲染
                  </button>
                  <button class={`tab ${raw ? 'active' : ''}`} onClick={() => setRaw(true)}>
                    原文
                  </button>
                </div>
              )}
              <button
                class="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(text ?? '').then(() => setCopied(true))
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </>
          )}

          <button class="btn icon" title="关闭 (Esc)" onClick={() => setPayload(null)}>
            ✕
          </button>
        </header>

        <div class={`modal-body ${img ? 'is-image' : ''}`}>
          {img ? (
            // key 让切换图片时缩放状态重置
            <ImageView key={`${imgIndex}-${img.data.length}`} img={img} />
          ) : asMarkdown ? (
            // 渲染模式下剥掉 Read 结果的行号前缀；"原文" 模式保留原样
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(stripLineNumbers(text ?? '')) }} />
          ) : (
            <FullText text={text ?? ''} lang={lang} />
          )}
        </div>
      </div>
    </div>
  )
}

function fileName(title: string, mediaType: string): string {
  const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  return `${title.replace(/[^\w一-龥.-]+/g, '_')}.${ext}`
}

/** 长文本分块 + content-visibility：几百 KB 也能秒开 */
function FullText({ text, lang }: { text: string; lang?: string }) {
  const chunks = useMemo(() => {
    const canHighlight = !!lang && text.length <= HIGHLIGHT_LIMIT
    if (canHighlight) return [highlight(text, lang)]
    const out: string[] = []
    for (let i = 0; i < text.length; i += CHUNK) out.push(escapeHtml(text.slice(i, i + CHUNK)))
    return out
  }, [text, lang])

  return (
    <pre class="modal-pre">
      {chunks.map((html, i) => (
        <code key={i} class="hljs vchunk" dangerouslySetInnerHTML={{ __html: html }} />
      ))}
    </pre>
  )
}
