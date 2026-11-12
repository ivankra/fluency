// Languages are BCP 47 tags ("en", "zh-CN"): speech APIs take them as `lang`, and
// they tell simplified from traditional Chinese. Names are derived with Intl.

export const COMMON_LANGUAGES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl',
  'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW',
]

// Canonical form ("zh-cn" → "zh-CN"), or null if not a valid tag.
export function canonicalLanguage(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.trim())[0] ?? null
  } catch {
    return null
  }
}

// Name of `tag` in `locale` (default: the browser's language); the tag itself if unknown.
export function languageName(tag: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}
