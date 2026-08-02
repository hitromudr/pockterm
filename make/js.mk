.PHONY: test-js test-ui

test-js: ## Run frontend unit tests (node --test)
	node --test test/*.test.mjs

# Browser tests: a real binary, a private tmux, and Chromium in a phone-sized
# viewport. Kept out of `check` because they need a browser on the machine.
test-ui: build ## Run the browser tests (needs chromium + npm install)
	node --test test/ui/
