/// <reference lib="webworker" />
import { Normalizer } from '../model/normalize'
import type { RawEvent, WorkerRequest, WorkerResponse } from '../model/types'

const PROGRESS_INTERVAL_MS = 80

function post(msg: WorkerResponse) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

/**
 * 流式解析：File.stream() → TextDecoderStream → 手写分行 → 逐行 JSON.parse。
 * 单行可能有数百 KB，所以绝不能在主线程做这件事。
 */
async function parse(file: File) {
  const norm = new Normalizer()
  const total = file.size
  let bytes = 0
  let lines = 0
  let lastPost = 0
  let tail = ''

  const reader = file.stream().pipeThrough(new TextDecoderStream('utf-8')).getReader()

  const handleLine = (line: string) => {
    const byteLen = line.length + 1
    if (!line.trim()) {
      bytes += byteLen
      return
    }
    lines++
    norm.countLine(byteLen)
    bytes += byteLen
    try {
      const raw = JSON.parse(line) as RawEvent
      norm.push(raw, lines, line)
    } catch {
      norm.countParseError()
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    tail += value
    let nl = tail.indexOf('\n')
    while (nl !== -1) {
      handleLine(tail.slice(0, nl).replace(/\r$/, ''))
      tail = tail.slice(nl + 1)
      nl = tail.indexOf('\n')
    }
    const now = performance.now()
    if (now - lastPost > PROGRESS_INTERVAL_MS) {
      lastPost = now
      post({ kind: 'progress', bytes, total, lines })
    }
  }
  if (tail) handleLine(tail.replace(/\r$/, ''))

  post({ kind: 'done', payload: norm.finish() })
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  if (e.data.kind !== 'parse') return
  parse(e.data.file).catch((err: unknown) => {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
