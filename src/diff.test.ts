import { describe, expect, it } from 'vitest'
import { diffWords, tokenize } from './diff'

const render = (before: string, after: string) =>
  diffWords(before, after)
    .map((part) => (part.type === 'same' ? part.text : part.type === 'added' ? `+[${part.text}]` : `-[${part.text}]`))
    .join('')

describe('tokenize', () => {
  it('splits words, spaces and punctuation', () => {
    expect(tokenize('¿Dónde está?')).toEqual(['¿', 'Dónde', ' ', 'está', '?'])
  })

  it('splits Chinese and Japanese into characters', () => {
    expect(tokenize('我在学中文。')).toEqual(['我', '在', '学', '中', '文', '。'])
    expect(tokenize('コーヒーを')).toEqual(['コ', 'ー', 'ヒ', 'ー', 'を'])
  })

  it('keeps every character', () => {
    for (const text of ['Me llamo Ana.', 'アナです。', "it's 3:30 — ok", '  ']) {
      expect(tokenize(text).join('')).toBe(text)
    }
  })
})

describe('diffWords', () => {
  it('marks a replaced word', () => {
    expect(render('Soy cansado.', 'Estoy cansado.')).toBe('-[Soy]+[Estoy] cansado.')
  })

  it('marks insertions and deletions', () => {
    expect(render('Hola amigo', 'Hola, amigo.')).toBe('Hola+[,] amigo+[.]')
    expect(render('Yo me llamo Ana.', 'Me llamo Ana.')).toBe('-[Yo me]+[Me] llamo Ana.')
  })

  it('works per character for Chinese and Japanese', () => {
    expect(render('我在学中问。', '我在学中文。')).toBe('我在学中-[问]+[文]。')
    expect(render('トイレがどこですか', 'トイレはどこですか？')).toBe('トイレ-[が]+[は]どこですか+[？]')
  })

  it('handles identical and empty strings', () => {
    expect(diffWords('Hola.', 'Hola.')).toEqual([{ type: 'same', text: 'Hola.' }])
    expect(diffWords('', 'Hola')).toEqual([{ type: 'added', text: 'Hola' }])
    expect(diffWords('Hola', '')).toEqual([{ type: 'removed', text: 'Hola' }])
  })

  it('falls back to a plain replacement for very long input', () => {
    const long = 'a '.repeat(400)
    expect(diffWords(long, 'b')).toEqual([
      { type: 'removed', text: long },
      { type: 'added', text: 'b' },
    ])
  })
})
