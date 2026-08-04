.PHONY: install uninstall qr test-install test-deploy test-repro test-sh

install: ## Install on this machine (binary, token, systemd unit)
	sudo bash deploy/install.sh

uninstall: ## Remove the unit and the binary (keeps the token file)
	sudo bash deploy/install.sh --uninstall

# PUBLIC_URL is the address your phone will open; without it the QR points at
# the loopback listener, which is only useful on the machine itself.
qr: ## Print the client link as a QR code (PUBLIC_URL=https://your.domain)
	@test -n "$(PUBLIC_URL)" || { echo "usage: make qr PUBLIC_URL=https://your.domain"; exit 1; }
	@POCKTERM_PUBLIC_URL="$(PUBLIC_URL)" \
	 POCKTERM_TOKEN="$$(sudo sed -n 's/^POCKTERM_TOKEN=//p' /etc/pockterm/pockterm.env 2>/dev/null)" \
	 $(BIN_DIR)/pockterm qr

test-install: ## Exercise deploy/install.sh in temporary paths
	bash test/install_test.sh

test-deploy: ## Exercise deploy/pockterm-deploy (stubbed systemctl and curl)
	bash test/deploy_test.sh

# Not in test-sh: it is two real cross-compiles, and CI already builds once.
test-repro: ## Check that the same source builds to the same bytes
	bash test/repro_test.sh

test-sh: test-install test-deploy ## Run both shell test suites
