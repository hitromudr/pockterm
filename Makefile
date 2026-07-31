.DEFAULT_GOAL := help
.PHONY: help

PROJECT := pockterm

# Extra targets live in make/*.mk modules; each annotated target
# ("target: ## Description") shows up in `make help` automatically.
-include make/*.mk

help: ## Show this help message
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_-]*:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
