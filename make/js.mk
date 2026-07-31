.PHONY: test-js

test-js: ## Run frontend unit tests (node --test)
	node --test test/*.test.mjs
