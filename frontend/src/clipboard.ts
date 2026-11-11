// Clipboard API 只在安全上下文可用；局域网 HTTP 在用户点击时使用浏览器复制命令。
export async function copyText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }
  const active = document.activeElement
  const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null
  const inputSelection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
      throw new Error('浏览器未允许复制')
    }
  } finally {
    field.remove()
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true })
    if (input && inputSelection && inputSelection[0] !== null && inputSelection[1] !== null) {
      input.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? undefined)
    } else if (selection) {
      selection.removeAllRanges()
      ranges.forEach(range => selection.addRange(range))
    }
  }
}
