import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

// 不引 highlight.js 自带主题：它是全局样式、无法按 data-theme 切换。
// token 配色写在 styles.css 里，用 CSS 变量支持深/浅两套。

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  kt: 'kotlin', kts: 'kotlin', java: 'java', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  swift: 'swift', m: 'objectivec', mm: 'objectivec', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', json5: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', md: 'markdown', markdown: 'markdown', gradle: 'groovy', groovy: 'groovy',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'diff', proto: 'protobuf',
}

export function langForPath(path?: string): string | undefined {
  if (!path) return undefined
  const name = path.split('/').pop() ?? ''
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  if (/^makefile$/i.test(name)) return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT_LANG[ext]
}

/** 返回高亮后的 HTML（已转义），语言未知时退回纯转义文本 */
export function highlight(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code)
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const marked = new Marked({ gfm: true, breaks: true })
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const l = lang?.trim().split(/\s+/)[0]
      return `<pre class="md-code"><code class="hljs">${highlight(text, l)}</code></pre>`
    },
  },
})

/**
 * Read 工具返回的文件内容带 `   12\t` 这样的行号前缀，直接按 markdown 渲染会全乱。
 * 前若干行里大多数都符合行号格式时才剥离，避免误伤正文里恰好以数字开头的内容。
 */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n')
  const sample = lines.slice(0, 40).filter((l) => l.length > 0)
  if (sample.length < 3) return text
  const numbered = sample.filter((l) => /^\s*\d+\t/.test(l)).length
  if (numbered / sample.length < 0.8) return text
  return lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n')
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false })
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}
