// Turning a swipe into scrolling that follows the finger.
//
// The screen lives in tmux, not in the page: xterm's own scrollback is empty
// under tmux, so a swipe is translated into mouse-wheel events and tmux moves
// its history. That leaves two things to get right, and both were wrong.
//
// How far. tmux scrolls five lines per wheel notch (`send-keys -X -N 5
// scroll-up` — its default binding), while the page sent one notch per row of
// finger travel. The content moved five times faster than the hand holding it,
// which is what "about four lines at a time, no smoothness" describes. The
// number is not assumed here: the server asks tmux what its binding says and
// tells the page.
//
// What happens after letting go. Nothing did. A flick that ends at speed
// should keep going and settle, the way every other scrolling surface on the
// phone behaves; without it the screen stops dead under the finger and the
// gesture feels broken even when the distance is right.
//
// The residue is honest: tmux moves whole lines, so with a five-line notch the
// smallest visible step is five lines. Tracking and inertia make it feel like
// scrolling; only a one-line binding would make it look continuous.

// How far the finger must travel before any of it becomes scrolling. A tap
// and a hold both wobble by a pixel or two, and with tmux moving whole lines
// per notch that wobble was visible movement. Nothing is lost: the travel so
// far is spent the moment the threshold is passed.
const SLOP = 6; // pixels

// How much of the swipe's tail decides the throw. Long enough to smooth out a
// jittery sample, short enough that a finger slowing to a halt is read as a
// halt.
const VELOCITY_WINDOW = 90; // milliseconds

// How long a finger may rest on the screen before lifting and still throw it.
// Deliberately larger than the window above: the two answer different
// questions, and conflating them costs the inertia this is here to give.
const PARK = 120; // milliseconds

// How far the drawn screen may be shifted to cover for what tmux has not drawn
// yet.
//
// The shift is content that has not arrived, so it shows as a band of
// background at the leading edge — which is the cost of following the finger
// over a network, and the cap is where that cost stops being worth paying.
// Two steps was too tight: at a moderate drag the trip keeps two or three
// messages in the air at once, and a clamped shift stops following the finger
// for a step of travel, which is the sticking this was meant to remove. Three
// steps is six rows of the device's screen at worst, and only while the finger
// is down.
const MAX_TRACK = 3; // steps

// How long an unanswered batch stays owed. This is a backstop, not a
// prediction: the page is told when the screen actually moved, and the only
// case with no answer at all is a scroll tmux cannot make — the top of the
// history, where the shift reads as an overscroll and has to let go by itself.
const AIR_MAX = 400; // milliseconds

// A flick decays to a stop rather than running to the end of the history.
// Tuned by hand on the device: lower is stickier.
const FRICTION = 0.94;
// Below this the glide is over — a fraction of a line per frame is jitter.
const MIN_SPEED = 0.02; // pixels per millisecond
// A frame's worth of time when the clock misbehaves (a backgrounded tab).
const MAX_STEP_MS = 50;

// movedWholeScreen tells a scroll from ordinary output by how much of the
// viewport xterm repainted.
//
// It decides when a wheel batch counts as drawn, so getting it wrong is silent
// in both directions: too eager and the shift is handed back while the content
// has not moved, too strict and it is held until the backstop expires. The
// numbers are measured on the stand rather than reasoned about — a character
// echoed into a 36-row screen renders [34,34], a scroll of the same screen
// renders [0,34]. Two rows of slack, because a scroll that lands together with
// output on the last row need not be missed.
export function movedWholeScreen(start, end, rows) {
  if (!(rows > 0)) return false;
  return end - start + 1 >= Math.max(4, rows - 2);
}

// Scroller converts finger movement into whole wheel notches, carrying the
// remainder so nothing is lost between events and the direction can reverse
// mid-swipe without a jump.
//
// Kept free of the DOM: what it does is arithmetic, and arithmetic that used
// to be wrong by a factor of five deserves tests.
export class Scroller {
  // notch(direction) is called for each wheel notch, +1 = towards history.
  // now() and raf() are injected so tests drive the clock.
  // onGesture({notches, glided, speed, ms, idle}) is called when a gesture and its
  // glide are over. Scrolling crosses a network — every notch is a message to
  // tmux and a redraw coming back — so how a swipe felt cannot be judged from
  // the page alone; these numbers are what the journal gets.
  // onTrack(px) is how the screen keeps up with the finger between whole
  // lines: the page shifts what is drawn by px until tmux has caught up. See
  // track() for why that is the page's job and not tmux's.
  constructor({ notch, onGesture = null, onTrack = null, now = () => Date.now(), raf = (fn) => requestAnimationFrame(fn) }) {
    this.notch = notch;
    this.onGesture = onGesture;
    this.onTrack = onTrack;
    this.now = now;
    this.raf = raf;
    this.pixelsPerNotch = 1;
    this.carry = 0;
    this.speed = 0;
    this.lastAt = 0;
    this.gliding = false;
    this.startedAt = 0;
    this.travel = 0;
    this.moving = false;
    this.notches = 0;
    this.glided = 0;
    this.samples = [];
    this.idle = 0;
    this.air = [];
    this.building = 0;
    this.ticking = false;
    this.touching = false;
    this.settling = false;
  }

  // report closes the books on a gesture: what was sent while the finger was
  // down, what the glide added, and how fast it was let go.
  report(at, speed) {
    // The shift is not touched here. It belongs to content still in the air,
    // and track() gives it back as that lands — or lets it go when nothing is
    // owed, which is the settle. Dropping it at this point is what made the
    // screen fly backwards the moment a finger left.
    this.settling = true;
    this.track(at);
    if (!this.onGesture) return;
    this.onGesture({
      notches: this.notches,
      glided: this.glided,
      speed: Math.round(Math.abs(speed) * 100) / 100,
      ms: Math.max(0, Math.round(at - this.startedAt)),
      // How long the finger had already stopped moving when the lift arrived.
      // It decides whether PARK is set anywhere near right: if this is
      // routinely above it, every swipe on the device ends without inertia
      // however the velocity is measured, and the number says so instead of
      // leaving it to taste.
      idle: this.idle,
    });
  }

  // How many pixels of travel make one notch: the row height times the lines
  // tmux moves per notch.
  setStep(pixels) {
    this.pixelsPerNotch = Math.max(1, pixels);
  }

  // The notches emitted so far have gone out as one message. The page batches
  // them per animation frame, and one batch is answered by one redrawn screen,
  // so this is what makes the two countable against each other.
  batched(at) {
    if (!this.building) return;
    this.air.push({ n: this.building, at });
    this.building = 0;
    // Re-read the shift: the batch is now something that can go unanswered, and
    // that is what starts the clock that lets it go.
    this.track(at);
  }

  // The notches queued for the next message are not going out after all: the
  // page threw the queue away, which is what leaving the history does. They
  // were never sent, so nothing owes them — and without this they would stay
  // owed for good, because only a message that went out can expire.
  dropped() {
    this.building = 0;
  }

  // The screen moved: the oldest batch in the air has been drawn.
  //
  // One redraw, one batch, oldest first. tmux draws a scroll as a repaint of
  // the whole pane and answers each message with one of them, so counting is
  // enough — and unlike a clock it cannot be wrong about a trip that took three
  // times the average, which is what made a long swipe judder.
  drew(at) {
    this.air.shift();
    this.track(at);
  }

  // Notches emitted and not yet known to be on the screen: what is queued for
  // the next message, plus every batch still in the air.
  owed(at) {
    while (this.air.length && at - this.air[0].at > AIR_MAX) this.air.shift();
    let n = this.building;
    for (const b of this.air) n += b.n;
    return n;
  }

  // Where the drawn screen has to be to sit under the finger.
  //
  // Only under the finger: see end() for why the glide is left alone.
  //
  // tmux moves whole lines — two per notch here — and answers over a tunnel,
  // so between notches the screen has nothing to say about where the finger
  // is: it stood still for a couple of lines of travel and then jumped, which
  // is "the scroll sticks every few lines" during a slow drag. Nothing in the
  // arithmetic of notches can fix that, because the smallest thing tmux can
  // draw is a line.
  //
  // So the page shifts the screen it already has by the travel tmux has not
  // drawn yet: the fraction of a line the finger is into (carry) plus the
  // notches still in flight. As each redraw lands the shift is given back by
  // exactly the amount the content moved, and the two cancel — the picture
  // moves once, with the finger, instead of twice against it.
  //
  // A batch stops being owed when the screen moves, not when a clock says it
  // should have. The first version predicted it from the measured round trip and
  // that could not work: on the device the trip averages 40-50ms and peaks at
  // 130, so a long swipe mispredicted several of its twenty notches and each
  // miss was a step back and forth — reported as juddering. Counting redraws
  // has no average in it.
  track(at) {
    if (!this.onTrack) return;
    if (!this.touching && !this.gliding && !this.settling) return;
    // Read what is owed first: owed() is also what expires a batch nobody
    // answered, and asking whether anything is left before that ran left the
    // sub-line residue on screen for good — a screen parked a few pixels off
    // its grid, which is the state this whole mechanism is meant to avoid.
    const owed = this.owed(at);
    // Nothing owed and nobody holding the screen: what is left is the fraction
    // of a line the finger travelled past the last whole one, and tmux cannot
    // draw that. It is the one thing the shift gives back without content
    // arriving.
    if (this.settling && !this.air.length && !this.building) {
      this.settling = false;
      this.onTrack(0);
      return;
    }
    const limit = MAX_TRACK * this.pixelsPerNotch;
    const px = this.carry + owed * this.pixelsPerNotch;
    this.onTrack(Math.max(-limit, Math.min(limit, px)));
    // A batch nobody answers has to expire on its own, so the shift is
    // revisited even while nothing is moving.
    if ((this.air.length || this.building) && !this.gliding && !this.ticking) {
      this.ticking = true;
      this.raf((t) => { this.ticking = false; this.track(t); });
    }
  }

  start(at) {
    this.gliding = false; // a touch always catches the glide
    this.touching = true;
    this.settling = false;
    this.ticking = false;
    this.carry = 0;
    this.speed = 0;
    this.lastAt = at;
    this.startedAt = at;
    this.travel = 0;
    this.moving = false;
    this.notches = 0;
    this.glided = 0;
    this.samples = [];
    this.idle = 0;
  }

  // How fast the finger was going over the last VELOCITY_WINDOW, rather than a
  // running average of the whole swipe.
  //
  // Reported as "a hard stop instead of inertia". A swipe on this device lasts
  // 1.3-1.9 seconds in the journal, and a smoothed average carries a residue
  // of all of it into the throw; what the hand did in the last fraction of a
  // second is what a flick means. The estimate is also read once, at the lift,
  // instead of being folded sample by sample — one jittery frame moves it by
  // its own share of the window and no further.
  //
  // Two spans, not one. The travel is measured between the samples themselves,
  // so a lift arriving late does not divide the distance by a longer time and
  // report a slower throw than the finger made; whether the lift is late is a
  // property of the WebView, not of the gesture. Resting before lifting is a
  // separate question with a separate answer, PARK below.
  velocity(at) {
    if (!this.samples.length) return 0;
    const last = this.samples[this.samples.length - 1].at;
    // Parked, then lifted: the screen stays where it was let go.
    if (at - last > PARK) return 0;
    const cutoff = last - VELOCITY_WINDOW;
    let dy = 0;
    let from = last;
    for (const s of this.samples) {
      if (s.at <= cutoff) continue;
      dy += s.dy;
      // The interval the sample covers, not the instant it arrived: taking the
      // first sample's timestamp leaves out its own interval and reads fast.
      from = Math.min(from, s.from);
    }
    const dt = last - from;
    if (dt < 1) return 0;
    // A careful drag is not a throw: without this every slow correction ended
    // in a glide of its own.
    if (Math.abs(dy) < SLOP) return 0;
    return dy / dt;
  }

  // dy is the movement since the last call, in pixels; positive = downwards
  // (towards older output).
  move(dy, at) {
    if (!this.moving) {
      this.travel += dy;
      if (Math.abs(this.travel) < SLOP) {
        this.lastAt = at;
        return;
      }
      this.moving = true;
      dy = this.travel; // spend what the finger has already covered
    }
    this.emit(dy, at);
    // Each sample carries the interval it covers, so the tail can be measured
    // without assuming the frames were evenly spaced.
    this.samples.push({ from: this.lastAt, at, dy });
    this.lastAt = at;
    // Only the tail matters; anything older cannot describe a flick.
    while (this.samples.length && this.samples[0].at <= at - VELOCITY_WINDOW) {
      this.samples.shift();
    }
    this.track(at);
  }

  // Let go: keep going if the finger was still moving.
  //
  // The shift is not handed back here, and that was the mistake in between:
  // for one version the lift dropped it at once, and with the cap at three
  // steps that is a screen flying six rows backwards the instant the finger
  // leaves — reported as exactly that. What the shift stands for does not
  // change at the lift: it is content that has not arrived, and it goes back
  // only as that content lands, which cancels out to no movement at all.
  end(at) {
    this.touching = false;
    this.settling = true;
    this.idle = this.samples.length ? Math.max(0, Math.round(at - this.samples[this.samples.length - 1].at)) : 0;
    this.speed = this.velocity(at);
    const thrown = this.speed;
    if (Math.abs(this.speed) < MIN_SPEED) {
      this.report(at, 0);
      return;
    }
    this.gliding = true;
    this.lastAt = at;
    this.thrownAt = thrown;
    this.raf((t) => this.glide(t));
  }

  glide(at) {
    if (!this.gliding) return;
    const dt = Math.min(MAX_STEP_MS, Math.max(1, at - this.lastAt));
    this.lastAt = at;
    const before = this.notches;
    this.emit(this.speed * dt);
    this.glided += this.notches - before;
    this.speed *= Math.pow(FRICTION, dt / 16.7);
    if (Math.abs(this.speed) < MIN_SPEED) {
      this.gliding = false;
      this.report(at, this.thrownAt || 0);
      return;
    }
    // The glide moves in whole lines too, and the same accounting covers it —
    // safely now that a batch is counted by the repaint that answers it rather
    // than by a predicted time. A fast glide keeps more messages in the air
    // than the cap allows, and then the picture rides at the cap instead of
    // following exactly; what it does not do is jump.
    this.track(at);
    this.raf((t) => this.glide(t));
  }

  stop() {
    this.gliding = false;
    this.speed = 0;
  }

  // Notches emitted here are owed until the screen is seen to move: they go
  // into the batch being built, which the page closes when it sends it.
  emit(dy, at = 0) {
    this.carry += dy;
    while (this.carry >= this.pixelsPerNotch) {
      this.carry -= this.pixelsPerNotch;
      this.notches++;
      this.building += 1;
      this.notch(1);
    }
    while (this.carry <= -this.pixelsPerNotch) {
      this.carry += this.pixelsPerNotch;
      this.notches++;
      this.building -= 1;
      this.notch(-1);
    }
  }
}
