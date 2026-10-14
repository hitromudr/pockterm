# Installing and deploying

What the installer does instead of asking a reader, and how a push reaches the host. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## The installer does what the README used to ask of a reader

Everything `deploy/install.sh` gained is one shape of defect: a step that was written down
instead of done, and whose absence does not look like an absence.

**A host without `tmux` is refused, not served** — the phone otherwise gets an empty
session list, which reads as a broken terminal rather than as a package nobody installed.
`make` is a warning instead, only the `+` button going through it. The refusal carries the
command that fixes it, picked off the package manager that exists rather than off
`/etc/os-release`.

**The session Makefile is installed, and `POCKTERM_SESSION_DIR` points at it.** Those were
four steps in the README — copy, edit, set the variable, restart — and the moment they are
wanted is the moment a phone has no session on it, which is the worst possible moment to
be reading a README. The root defaults to the served account's home. Two refusals inside
that, both about not owning what we did not write: a Makefile already in the root is never
overwritten (`make claude` in somebody else's Makefile is an unknown target, not a
session), and then the variable is not written either, since pointing the `+` button at
unknown targets is worse than leaving it off. A copy of ours is recognised by
`pockterm-sessions` in the header and left exactly as edited, the file being meant for
editing. `GNUmakefile` and `makefile` count as the Makefile that is there — make reads the
first of the three, so writing `Makefile` beside a `GNUmakefile` would install a file make
never opens and report success.

**A restart happens when the env file changed, and only then.** systemd reads that file at
start, so anything added is not in force yet; and a restart drops every open terminal, so
an install that changed nothing must cost nobody a reconnect.

**`--tg` runs the pairing that already existed.** `pockterm tg-setup` has done the
mechanical half since it was written; what it could not do is be remembered, and the part
left out afterwards was the restart. Its failure ends only itself — the install stands and
prints the link, a bot that is not ready being no reason to have no terminal.

`test/install_test.sh` covers each of those, including both answers where a machine can
only give one: `REQUIRE_TMUX`/`REQUIRE_MAKE` name the tool to look for, so the missing-tool
path is exercised on a host that has it, and a stub `tmux` on `PATH` lets the happy path
run in a container that has none.

## Deploy

A push to `main` builds, tests and hands the binary over, and **the host installs it at
once**. Do not install by hand on the RPi5, and do not run the `pockterm_app` ansible
role's binary copy against it.

`.forgejo/workflows/deploy.yml` runs on the runner that lives on that same box. The job
builds in a container and drops `pockterm.new` plus an HMAC signature into
`/var/lib/pockterm/incoming`; the host watches that path (`pockterm-deploy.path`) and
`/usr/local/sbin/pockterm-deploy` verifies the signature and takes it from there.
Identical bytes are a no-op, so a docs-only push does not drop anyone's terminal; a binary
that fails to start is rolled back.

**That no-op needs the build to be reproducible, and for a day it was not.** `go build`
stamps the commit hash into the binary and the build directory along with it, so every
push produced new bytes and every push restarted the unit — found on 2026-08-04 by a
commit that touched only this file. `BUILD_FLAGS` in `make/go.mk` is `-trimpath
-buildvcs=false` for that reason, and `make test-repro` builds the tree twice under
different paths to prove it. It is two real cross-compiles, so it is not part of `make
check` — run it when the build line changes. The cost is that the binary no longer says
which commit it is; it says which version, below.

The deploy used to wait for nobody to be looking, which cost a parked build, a retry
timer, a `waiting` flag on `/api/presence` and a line in the menu explaining why the
version would not change — and the person waiting for the fix was the one holding it up.
**The wait was removed on 2026-08-03.** A restart costs a reconnect, the tmux session
behind it is untouched, and the page says what to do about the rest: the server names the
page it serves in the socket's `config` frame, and a page running anything else shows a
bar with **Обновить** on it. A reload rather than an automatic one, because the composer
can have half a message in it; the button is a plain `location.reload()`, the service
worker being network-first.

Until 2026-10-14 that mechanism's number was `vNNN`, bumped by hand in `app.js` and
`sw.js` together with a test to catch the drift — and still forgotten often enough to
need a memory of its own. Now nobody writes it. `tools/version.sh` counts it from the git
history: MAJOR.MINOR.PATCH starting at v219 = 1.0.0, `feat` moves the minor, a `!` in the
type the major, any other commit touching the binary's sources the patch. Commits touching
only docs, tests or CI move nothing, which is what keeps the reproducible no-op above
alive: the number is in the bytes. The build stamps it in (`-X …/pockterm.version`,
`make/go.mk` and `install.sh` alike); the two files carry the mark `__PT_VERSION__`, and
the binary writes its version over it as it serves them (`Static` in `version.go`), so the
page, the service worker's cache name and the `config` frame cannot disagree. A tree
without the history (shallow clone, tarball, the copies of `test-repro`) is `0.0.0-dev`;
the release workflow clones with full depth and refuses a tag that is not `v` plus the
computed version. `test/version_test.sh` covers the counting.

The host-side pieces — `pockterm-deploy`, its `.path` and `.service` — live in `deploy/`
and are covered by `test/deploy_test.sh` (`make test-deploy`), which stubs systemctl.

That path installs on the RPi5 only. For everyone else there are releases:
`.github/workflows/release.yml` fires on a `v*` tag, runs `make release` (both
architectures plus `SHA256SUMS`) and publishes them, and `deploy/install.sh` downloads one
when no Go toolchain is present. The checksum check is not decoration — a binary that does
not match is refused, and `test/install_test.sh` covers both outcomes with a `file://`
release.

The signing key is the repo Actions secret `DEPLOY_HMAC_KEY` and
`/etc/pockterm/deploy-hmac.key` on the host. It exists because the drop directory is
mounted into a job container and the runner serves other repositories too — without it,
any workflow could have the host install a binary as root.
