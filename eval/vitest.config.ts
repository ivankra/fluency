import { defineConfig } from 'vitest/config'

// Separate config so the paid evaluation never runs as part of `make test`.
export default defineConfig({ test: { include: ['eval/**/*.eval.ts'], silent: false } })
