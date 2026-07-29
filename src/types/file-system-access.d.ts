/**
 * File System Access API 的补充声明。
 * lib.dom 里 FileSystemHandle 缺少权限查询和 showOpenFilePicker，这里补齐。
 */
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  queryPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[]
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: string | FileSystemHandle
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
}
