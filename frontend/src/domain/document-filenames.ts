import type { DocumentVersion } from './contracts'

export function managedDocumentFilename(version: DocumentVersion): string {
  return version.managed_filename?.trim() || version.original_filename
}

export function traceableDocumentFilename(version: DocumentVersion): string {
  const managed = managedDocumentFilename(version)
  if (managed === version.original_filename) return managed
  return `${managed}（原文件名：${version.original_filename}）`
}
