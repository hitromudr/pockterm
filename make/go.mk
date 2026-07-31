.PHONY: deps build build-arm64 test test-v lint format check clean deploy

GO      ?= go
BIN_DIR := bin

# Deploy target host, override: make deploy DEST=user@host
DEST    ?=

deps: ## Download and verify dependencies
	$(GO) mod download
	$(GO) mod verify

build: ## Build for the current platform into bin/
	@mkdir -p $(BIN_DIR)
	$(GO) build -o $(BIN_DIR)/ ./cmd/...

build-arm64: ## Cross-compile linux/arm64 into bin/$(PROJECT)-linux-arm64
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build \
		-o $(BIN_DIR)/$(PROJECT)-linux-arm64 ./cmd/$(PROJECT)

test: ## Run tests
	$(GO) test ./...

test-v: ## Run tests verbosely
	$(GO) test ./... -v

lint: ## Run vet
	$(GO) vet ./...

format: ## Format code
	$(GO) fmt ./...

check: format lint test test-js ## Format, vet, go and js tests

clean: ## Remove build artifacts
	rm -rf $(BIN_DIR)

deploy: build-arm64 ## Rsync binary to DEST and restart the unit
	@test -n "$(DEST)" || { echo "usage: make deploy DEST=user@host"; exit 1; }
	rsync -av $(BIN_DIR)/$(PROJECT)-linux-arm64 $(DEST):/usr/local/bin/$(PROJECT).new
	ssh $(DEST) 'mv /usr/local/bin/$(PROJECT).new /usr/local/bin/$(PROJECT) && \
		systemctl restart $(PROJECT) && systemctl --no-pager status $(PROJECT)'
