# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Overview

Mobile web terminal for a tmux session (PWA + Go single binary).

## Commands

```bash
make help    # list targets
make check   # format, lint, tests
```

## Conventions

Code comments are in English. User-facing documentation is bilingual:
`README.md` (Russian) and `README.en.md` (English).

## Deploy

A push to `main` deploys to the RPi5 by itself — do not install by hand there,
and do not run the `pockterm_app` ansible role's binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box.
The job builds in a container and drops `pockterm.new` plus an HMAC signature
into `/var/lib/pockterm/incoming`; the host watches that path
(`pockterm-deploy.path`) and `/usr/local/sbin/pockterm-deploy` verifies the
signature, installs the binary and restarts the unit. Identical bytes are a
no-op, so a docs-only push does not drop anyone's terminal; a binary that
fails to start is rolled back to the previous one.

The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host. It exists because the drop
directory is mounted into a job container and the runner serves other
repositories too — without it, any workflow could have the host install a
binary as root.
