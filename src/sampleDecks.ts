// Starter decks so a fresh install has something to practice.
// Each card is [front (English prompt), back (target-language sentence)].
import { addCard, addDeck, listDecks } from './db'

const SAMPLE_DECKS: { name: string; cards: [string, string][] }[] = [
  {
    name: 'Spanish',
    cards: [
      ['Hello, how are you?', 'Hola, ¿cómo estás?'],
      ['My name is Ana.', 'Me llamo Ana.'],
      ['Nice to meet you.', 'Mucho gusto.'],
      ['Where is the bathroom?', '¿Dónde está el baño?'],
      ['I would like a coffee, please.', 'Quisiera un café, por favor.'],
      ['How much does it cost?', '¿Cuánto cuesta?'],
      ["I don't understand.", 'No entiendo.'],
      ['Can you speak more slowly?', '¿Puedes hablar más despacio?'],
      ['I am learning Spanish.', 'Estoy aprendiendo español.'],
      ['See you tomorrow.', 'Hasta mañana.'],
    ],
  },
  {
    name: 'Chinese',
    cards: [
      ['Hello, how are you?', '你好，你好吗？'],
      ['My name is Ana.', '我叫安娜。'],
      ['Nice to meet you.', '很高兴认识你。'],
      ['Where is the bathroom?', '洗手间在哪里？'],
      ['I would like a coffee, please.', '请给我一杯咖啡。'],
      ['How much does it cost?', '这个多少钱？'],
      ["I don't understand.", '我听不懂。'],
      ['Can you speak more slowly?', '你能说慢一点吗？'],
      ['I am learning Chinese.', '我在学中文。'],
      ['See you tomorrow.', '明天见。'],
    ],
  },
  {
    name: 'Japanese',
    cards: [
      ['Hello, how are you?', 'こんにちは、お元気ですか？'],
      ['My name is Ana.', 'アナです。'],
      ['Nice to meet you.', 'はじめまして。'],
      ['Where is the bathroom?', 'トイレはどこですか？'],
      ['I would like a coffee, please.', 'コーヒーをお願いします。'],
      ['How much does it cost?', 'いくらですか？'],
      ["I don't understand.", 'わかりません。'],
      ['Can you speak more slowly?', 'もう少しゆっくり話してください。'],
      ['I am learning Japanese.', '日本語を勉強しています。'],
      ['See you tomorrow.', 'また明日。'],
    ],
  },
]

const SEEDED_KEY = 'fluency:sample-decks-seeded'

// Add the sample decks once, on a fresh install. Never re-adds them after the
// user deletes them, and never touches a database that already has decks.
export async function seedSampleDecks() {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return
  } catch {
    // Storage unavailable; fall back to the empty-database check below.
  }

  if ((await listDecks()).length === 0) {
    for (const { name, cards } of SAMPLE_DECKS) {
      const deck = await addDeck(name)
      for (const [front, back] of cards) await addCard(deck.id, front, back)
    }
  }

  try {
    localStorage.setItem(SEEDED_KEY, '1')
  } catch {
    // Ignore; the empty-database check still prevents duplicates.
  }
}
