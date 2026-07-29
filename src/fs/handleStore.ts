/**
 * 用 IndexedDB 持久化 FileSystemFileHandle，实现"最近打开"离线秒开。
 * 句柄本身可结构化克隆，重新读取前需要 requestPermission。
 */
const DB_NAME = 'ai-log-formatter'
const STORE = 'recent'
const MAX_RECENT = 12

export interface RecentEntry {
  key: string
  name: string
  size: number
  openedAt: number
  handle?: FileSystemFileHandle
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        t.oncomplete = () => db.close()
      }),
  )
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>)
    return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export async function rememberFile(file: File, handle?: FileSystemFileHandle) {
  const entry: RecentEntry = {
    key: `${file.name}:${file.size}`,
    name: file.name,
    size: file.size,
    openedAt: Date.now(),
    handle,
  }
  try {
    await tx('readwrite', (s) => s.put(entry))
    const all = await listRecent()
    const stale = (await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>)).filter(
      (e) => !all.some((k) => k.key === e.key),
    )
    for (const e of stale) await tx('readwrite', (s) => s.delete(e.key))
  } catch {
    /* 无痕模式 / 配额不足时静默降级 */
  }
}

export async function forgetFile(key: string) {
  try {
    await tx('readwrite', (s) => s.delete(key))
  } catch {
    /* ignore */
  }
}

/** 重新读取历史句柄；权限被拒或文件已移动时返回 null */
export async function reopen(entry: RecentEntry): Promise<File | null> {
  const h = entry.handle
  if (!h) return null
  try {
    const perm = await h.queryPermission({ mode: 'read' })
    if (perm !== 'granted') {
      const asked = await h.requestPermission({ mode: 'read' })
      if (asked !== 'granted') return null
    }
    return await h.getFile()
  } catch {
    return null
  }
}
