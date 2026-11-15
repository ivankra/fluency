// Word-level diff between the learner's answer and the corrected sentence, for
// highlighting what changed. Pure.

export interface DiffPart {
  type: 'same' | 'removed' | 'added'
  text: string
}

// Chinese and Japanese don't separate words with spaces, so each character is a
// token. Elsewhere a token is a run of letters/digits, a run of spaces, or one
// punctuation mark.
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々'
const TOKEN = new RegExp(`[${CJK}]|[^\\s\\p{P}\\p{S}${CJK}]+|\\s+|.`, 'gsu')

export const tokenize = (text: string) => text.match(TOKEN) ?? []

// Beyond this many tokens the quadratic table isn't worth it; show a plain replacement.
const MAX_TOKENS = 300

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before)
  const b = tokenize(after)
  const parts: DiffPart[] = []
  const push = (type: DiffPart['type'], text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === type) last.text += text
    else parts.push({ type, text })
  }

  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    if (before) push('removed', before)
    if (after) push('added', after)
    return parts
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push('same', a[i++])
      j++
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      push('added', b[j++])
    } else {
      push('removed', a[i++])
    }
  }
  return parts
}
