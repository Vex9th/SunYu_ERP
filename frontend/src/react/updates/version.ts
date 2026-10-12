const semanticVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 在线更新按组件版本排序；构建标识不影响顺序，无法识别的版本不自动推荐。 */
export function isNewerVersion(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  const next = candidate?.match(semanticVersion)
  const current = installed?.match(semanticVersion)
  if (!next || !current) return false
  for (let index = 1; index <= 3; index++) {
    const nextNumber = BigInt(next[index]!)
    const currentNumber = BigInt(current[index]!)
    if (nextNumber !== currentNumber) return nextNumber > currentNumber
  }
  if (!next[4] || !current[4]) return !next[4] && Boolean(current[4])
  const nextPre = next[4].split('.')
  const currentPre = current[4].split('.')
  for (let index = 0; index < Math.max(nextPre.length, currentPre.length); index++) {
    const left = nextPre[index]
    const right = currentPre[index]
    if (left === right) continue
    if (left === undefined || right === undefined) return right === undefined
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right)
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return false
}
