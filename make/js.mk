.PHONY: test-js test-ui parse-js

# A syntax error in the page is not a failing feature, it is no page at all: the
# module never evaluates, nothing is wired, and from a phone that looks like a
# machine with no tmux sessions. The unit tests import the modules they cover one
# at a time and app.js is covered by none of them, so this is what stands between
# a stray duplicate declaration and a deploy.
parse-js: ## Parse every page script (node --check)
	node --check web/sw.js
	for f in web/js/*.js; do node --check "$$f" || exit 1; done

test-js: parse-js ## Run frontend unit tests (node --test)
	node --test test/*.test.mjs

# Browser tests: a real binary, a private tmux, and Chromium in a phone-sized
# viewport. Kept out of `check` because they need a browser on the machine.
test-ui: build ## Run the browser tests (needs chromium + npm install)
	node --test test/ui/
