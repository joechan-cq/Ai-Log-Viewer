/** 打开文件的三条路：File System Access API、拖拽、file input。加上 PWA 的 launch_queue。 */

const TYPES: FilePickerAcceptType[] = [
  {
    description: 'AI stream-json 日志',
    accept: { 'application/x-ndjson': ['.jsonl', '.ndjson'], 'text/plain': ['.log', '.txt'] },
  },
]

export interface Picked {
  file: File
  handle?: FileSystemFileHandle
}

export function hasFsAccess(): boolean {
  return typeof window.showOpenFilePicker === 'function'
}

export async function pickFile(): Promise<Picked | null> {
  if (hasFsAccess()) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false })
      return { file: await handle.getFile(), handle }
    } catch {
      return null // 用户取消
    }
  }
  return await pickViaInput()
}

function pickViaInput(): Promise<Picked | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.log,.jsonl,.ndjson,.txt,application/x-ndjson,text/plain'
    input.onchange = () => resolve(input.files?.[0] ? { file: input.files[0] } : null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** PWA 被当作文件处理器启动时（双击 .log），从 launchQueue 取文件 */
export function onLaunchWithFile(cb: (picked: Picked) => void) {
  const q = (window as unknown as { launchQueue?: { setConsumer(c: (p: { files: FileSystemFileHandle[] }) => void): void } })
    .launchQueue
  if (!q) return
  q.setConsumer(async (params) => {
    const handle = params.files?.[0]
    if (!handle) return
    try {
      cb({ file: await handle.getFile(), handle })
    } catch {
      /* ignore */
    }
  })
}

/** 拖拽：优先拿句柄（可存进最近打开），拿不到就退回 File */
export async function fileFromDrop(e: DragEvent): Promise<Picked | null> {
  const item = e.dataTransfer?.items?.[0]
  if (item && 'getAsFileSystemHandle' in item) {
    try {
      const h = (await (item as DataTransferItem & {
        getAsFileSystemHandle(): Promise<FileSystemHandle | null>
      }).getAsFileSystemHandle()) as FileSystemFileHandle | null
      if (h?.kind === 'file') return { file: await h.getFile(), handle: h }
    } catch {
      /* fall through */
    }
  }
  const f = e.dataTransfer?.files?.[0]
  return f ? { file: f } : null
}
