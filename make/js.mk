.PHONY: test-js

test-js: ## Run frontend unit tests (node --test)
	node --test web/js/*.test.mjs
