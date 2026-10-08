// Export decks as files the user can save or open in other apps.
import { exportAll, type Card, type Deck } from './db'

function download(filename: string, type: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoke later: Safari aborts the download if the URL is freed immediately.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'deck'
const today = () => new Date().toISOString().slice(0, 10)

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

// Front/back CSV, importable into Anki, Quizlet and spreadsheets.
export function exportDeckCsv(deck: Deck, cards: Card[]) {
  const rows = [['front', 'back'], ...cards.map((c) => [c.front, c.back])]
  const csv = rows.map((r) => r.map(csvField).join(',')).join('\r\n')
  // The BOM makes Excel read the file as UTF-8 (needed for Chinese/Japanese).
  download(`${safeName(deck.name)}.csv`, 'text/csv;charset=utf-8', '﻿' + csv)
}

// Full JSON backup of every deck, card and review.
export async function exportBackupJson() {
  const data = await exportAll()
  download(`fluency-backup-${today()}.json`, 'application/json', JSON.stringify(data, null, 2))
}
