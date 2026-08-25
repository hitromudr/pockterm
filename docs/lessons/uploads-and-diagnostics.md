# Uploads, limits and the journal

What the device can say about itself, and what a file has to carry to be taken. These sections were moved out of `CLAUDE.md`, which keeps the
rule and a pointer; the derivation, the measurements and the dates are here. Read the
ones your change touches before making it — every one of them was paid for at least
twice.

## Diagnostics

The page posts what decides an outcome to `/api/log`, which the server writes to its
journal (`journalctl -u pockterm | grep client:`): the environment on load — version,
secure context, which clipboard APIs exist, whether the native bridge is there — plus
copy/paste/upload results and uncaught errors. The device this serves has no console
anyone can open, and every fix before this was a guess.

**A refused upload had been the one outcome that wrote nothing down.** Only the successful
path reported, so "413 при загрузке фото" arrived with nothing in the journal to put
beside it — and 413 is a status this server never sends. It comes from the nginx in front,
whose default body limit is one megabyte: a screenshot is a few hundred kilobytes and went
through for months, a camera frame is several megabytes and never did. The limit lives in
the `pockterm_vhost` role in the devops repository (`client_max_body_size`, just above
`upload.MaxBytes` so an oversized file is refused by this program's own words rather than
by the proxy's status code), and it takes a deploy of that role to be in force. The page
names the proxy instead of pasting nginx's HTML into a toast, and logs the failure with
its status and the size.

**The two numbers are one setting in two repositories, and only one of them takes effect on
its own.** Raised to 20 MB / 22 MB on 2026-08-19, for documents — a scanned PDF is what a
camera frame was to the old bound — and to 100 MB / 105 MB on 2026-08-25, for film. The
order is not free: raise the proxy first and lower this program first, so that at every
moment in between the app's number is the lower of the two and the refusal keeps its words. Between them lies a range that comes back as a 413 this
server never sent, so a bump here that is not matched there buys nothing above the proxy's
number: `MaxBytes` cannot be the answer to "how large may a file be" while something in
front says less. And the deploys are not the same either — this binary is installed by CI on
every push to `main`, the vhost by an ansible role against HITRO
(`hosts: control_node`). That role does run from the malina, which the note here used to
deny: the sandbox has no direct route to HITRO, but `~/.ssh/config` rewrites the inventory's
address to `127.0.0.1:2201`, the forward the `sandbox_forward` role keeps — so
`ansible-playbook … deploy_pockterm.yml -e pockterm_vhost_enabled=true --limit control_node`
reaches it. Measured on 2026-08-25 by raising the pair: `--check --diff` first, then the run,
`nginx -t` and reload in the handlers, and the live file read back afterwards. Limiting to
`control_node` is not optional from here — the same playbook's first play targets RPI5, whose
inventory name does not resolve on this machine.

Both halves are in force since 2026-08-19, and they were **measured through the door rather
than read off the two files**: a 13 MB body — over the old proxy bound, under the new one —
comes back `200` with a path, and 21 MB comes back `400 larger than 20971520 bytes`, which is
this program's own sentence and not the proxy's HTML. That second answer is the whole point of
the ordering, and it is the only one of the two that says which bound was reached.

## A message about screens is usually about several of them

One upload is one request — `/api/upload` takes a body, not a form — so a selection of
files is a request each. `attachFiles` sends them **one after another**: the phone
reaches this host down a single tunnel, the proxy in front bounds each body rather than the
batch, and the paths have to be typed in the order they were picked.

**The paths go out in one write**, once the last upload is in. `term.paste` honours
bracketed paste, so what the agent is handed is one message naming several files rather
than one message per picture — and a message per picture is a turn per picture.

Where several can arrive: the file chooser (`multiple`, and on a phone the only such path —
the clipboard holds one picture and there is nothing to drag a file onto), a drop from a
desktop file manager, and a paste. `pickFiles` reads `files` **whole when it holds
anything** and falls back to `items` only otherwise: a drop exposes the same file through
both lists, and collecting from each in turn uploaded it twice. `chosenFiles` is the
chooser's own answer as a list, and it filters nothing — see the section below for why the
`accept` went away.

Two bounds, both about saying what happened. `ATTACH_MAX` is 10 — a gallery keeps "select
all" within reach of the thumb that picks two screenshots, and each one is a request and a
file on this host's disk — and what is left over is **said** rather than dropped quietly.
And a batch that lost one of its pictures says so against what was picked: the paths that
did arrive are on screen, so counting them is the only way to notice from a phone. Every
upload keeps its own journal line, now with `n` and `of` in it, which is what tells a batch
from three separate pastes.

## A document is known by its name, an image by its bytes

The road a screenshot takes is the road anything takes — bytes to `/api/upload`, a path back,
the path typed into the pane — and for a long time the page and the store were the only
things refusing to carry a spec, a log or a patch down it. Two levers held it shut, and
neither was about what an agent can read: `accept="image/*"` on the picker, so the phone
offered the gallery and nothing else, and an allowlist of sniffed types in `upload.Save`,
so a `.md` came back as *not an image*.

**What a document costs that a picture does not is its name.** The bytes of a PNG say what
they are; a Makefile, a patch, a note and a `.csv` are one content type between them
(`text/plain`, and half the rest is `application/octet-stream`), and the extension is what
tells an agent which it is holding. So the browser's own `File.name` travels with the body
(`?name=`, in the query rather than a header — it arrives in whatever alphabet the file was
named in, and a query string carries that with no encoding to agree on) and the rule became
two clauses:

- **an image is known by its bytes** and keeps the extension they earn, named or not — a
  screenshot off the clipboard is a blob with no name at all, and a name claiming otherwise
  does not change what is in the file, so a PNG called `shot.jpeg` lands as `-shot.png`;
- **anything else is taken only when the browser names it.** An unnamed non-image is refused
  exactly as before: there is nothing to call it and nothing in it that would say.

**The name is filtered, never refused.** It becomes a path and is then typed into a pane, so
`safeName` replaces what could be a directory, an option or a second word — separators, a
space, a quote, a glyph a shell would read — and cuts a long one out of the middle, keeping
the extension because that is the half an agent reads. What it does **not** touch is the
alphabet: `заметки по стенду.md` comes back as `заметки-по-стенду.md`, this program having no
business transliterating the owner's own names, and what makes a path hazardous being
punctuation. A name left with nothing in it is no name, and then the image rule stands alone.

The store's other bounds are unchanged and now cover more: 0600 (a document holds whatever a
screenshot holds), `MaxBytes` with the proxy's own limit just above it (see the Diagnostics
section: the two move together or the higher one is decoration), and the 24-hour sweep — a
file handed to an agent is a scratch file whatever is in it.

**Since 100 MB the store also has a size** (`MaxTotal`, 1 GiB). `Keep` answers "how long",
which was the whole of the arithmetic while a file was a screenshot: a day of them is a few
tens of megabytes. A day of film is not, and the disk under this directory carries git and
passwords too. So age is swept first, then the oldest of what is left leaves until the total
fits. Two details are load-bearing. The cap is a multiple of `MaxBytes` rather than a share
of free space — what is bounded is this program's appetite, not the machine's capacity, and a
bound read off the disk would grow silently on a bigger one. And **the file just saved is
named to the sweep, not deduced from mtime**: its path is about to be handed to the page, an
agent opens it a second later, and a single upload the size of the whole cap would otherwise
delete itself. `TestSaveKeepsTheFileItJustSaved` is that case; it fails if the exemption goes
away.

**And the clip asks which source, because `accept` cannot ask for all of them.** Dropping the
filter was what let a document in, and it made the common case slower: `accept="image/*"`
opens Android's chooser on the gallery and puts a document out of reach entirely, no
`accept` opens the file manager and buries a screenshot three taps in. That is trading one
for the other rather than having both, so 📎 opens a popup — 📷 Снять фото, 🖼 Картинки,
📄 Документы — and each answer sets the pair and opens the **same** input. Two inputs would
be two answers to what has just been picked. The picker is opened from inside the tap on a
source, a browser handing a file chooser to a gesture and to nothing else, which is the same
rule `askKeyboard` lives by.

The third source, added 2026-08-25, is the camera: `capture="environment"` on the same
`image/*` input skips the chooser and opens it directly, so what is in front of the phone
reaches the agent without a trip through the gallery. Two things about it are worth keeping.
It is **a request, not a guarantee** — a desktop has no camera and ignores the attribute,
which is why the stand asserts the attribute and nothing more, and why the phone is the
judge here as everywhere else. And because the input is shared, **`capture` is state that
outlives the tap**: every source sets both halves and the other two remove the attribute
rather than emptying it, or the gallery opens the camera for whoever chose it last. That is
the same "one owner per fact" the composition state is held by — the input's configuration
belongs to the source being tapped, not to the one before it. The browser test walks the
camera and the gallery in that order for exactly this reason.

**A tap on a source is written down, and so is what came back.** The first photo taken this
way did not arrive, and the journal could not say where it stopped: an upload line is written
only once there is a file, so "the camera never opened", "it was closed without a shot" and
"it came back with nothing" were one silence — the only trace was `{"event":"kb","after":
"attach-photo","ms":19734}`, a keyboard rising twenty seconds later, which says the owner went
somewhere and came back and nothing else. So `pick` is written on the tap (with the pair it
set), `picked` on the answer with the count, and a dismissed chooser is `cancelled: true`. A
`pick` with nothing after it is now its own diagnosis: the app never handed the page an answer
at all. On screen the same gap is a toast — `attachFiles` returns silently on an empty list
because a paste and a drop call it too, so the one path that *asked* for a file says so
itself.

**A film is a source, not a new kind of upload** (2026-08-25). `video/*` opens the same
gallery on the films instead of the stills, and what comes back travels the document path:
the bytes sniff as `video/mp4` or `video/webm`, neither is in `byType`, so what decides is the
name the browser gave it — a film with no name is refused exactly as a note with no name is,
there being no extension to hand an agent. That is measured rather than assumed: the same
`http.DetectContentType` answers `application/octet-stream` for a QuickTime brand it does not
know. Two tests hold the pair together, one in the store (`TestSaveTakesAVideoByItsName`) and
one through the page, because "the source exists and the store refuses what it hands over"
would be a button that always fails.

What a film meets first is the size bound, and it meets it routinely — a phone shoots several
megabytes a second, so the 20 MB in force when the source was added held a clip of a few
seconds. That is what raised the pair to 100 MB / 105 MB the same day, on the owner's number,
with the store's own cap (above) added in the same change so that "not filling the disk" is a
property rather than an intention. The refusal reads `larger than 100 MB` rather than a count
of bytes, for the same reason the rest of this file exists: it is read in a toast, on a phone,
by a thumb.

What the camera does hit is the size bound described above: a screenshot is a few hundred
kilobytes, a camera frame is several megabytes, and 413 from the proxy was first seen with a
photo. It is refused in this program's own words up to the proxy's number and by the proxy
above that; nothing about the new source changes which of the two speaks.

Three things it inherits from the popups already here. It is **drawn over the terminal**,
anchored to `#modebar` itself (`bottom: 100%`) rather than to a number of pixels — the bar is
padding plus the system inset, and the pager's own 64px guess ended up sitting on the
composer's ▶. It **shares the one scrim** with the presets under `+`: two would be two
answers to what a tap outside does, so `showTermPopup` owns which is open and opening one
closes the other — including `setPanelsHidden`, since a scrim left behind by a popup whose
bar has just been hidden is an invisible sheet over the whole screen. And **nothing in it
takes focus** (`keepsTerminalFocus` on the clip, the sources and the scrim). The CSS is two
ids deep (`#modebar #attach-menu button`) because `#modebar button` matches those buttons
too, and equal specificity would leave the answer to whichever rule was written last — the
same trap that drew the mark picker's button as a full-width bar.
