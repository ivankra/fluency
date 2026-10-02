.PHONY: help install dev build preview typecheck clean distclean

help: ## Show available targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

node_modules: package.json
	npm install
	@touch node_modules

install: node_modules ## Install dependencies

dev: node_modules ## Start the dev server
	npm run dev

build: node_modules ## Typecheck and build for production
	npm run build

preview: build ## Build and serve the production bundle (test PWA install/offline here)
	npm run preview

typecheck: node_modules ## Run the TypeScript compiler without emitting
	npx tsc --noEmit

clean: ## Remove build output
	rm -rf dist dev-dist

distclean: clean ## Remove build output and node_modules
	rm -rf node_modules
