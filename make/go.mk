.PHONY: deps build build-arm64 build-amd64 release test test-v lint format check clean deploy

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

build-amd64: ## Cross-compile linux/amd64 into bin/$(PROJECT)-linux-amd64
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build \
		-o $(BIN_DIR)/$(PROJECT)-linux-amd64 ./cmd/$(PROJECT)

# What a release publishes: both binaries and the sums install.sh verifies
# them against. Static (CGO off), so they run on whatever libc is there.
release: build-amd64 build-arm64 ## Build the release artifacts into dist/
	@rm -rf dist && mkdir -p dist
	cp $(BIN_DIR)/$(PROJECT)-linux-amd64 $(BIN_DIR)/$(PROJECT)-linux-arm64 dist/
	cd dist && sha256sum $(PROJECT)-linux-* > SHA256SUMS
	@echo "dist/:" && ls -1 dist

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
