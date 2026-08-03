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
// yet. The shift is a prediction, and a wrong one shows as a band of
// background at one edge; two steps is what a slow drag needs, where a single
// notch is in flight at a time.
const MAX_TRACK = 2; // steps

// How long a notch takes to come back as a redrawn screen, until the page has
// measured it on this connection. The journal says 17-78ms here.
const DEFAULT_LAG = 60; // milliseconds

// A flick decays to a stop rather than running to the end of the history.
// Tuned by hand on the device: lower is stickier.
const FRICTION = 0.94;
// Below this the glide is over — a fraction of a line per frame is jitter.
const MIN_SPEED = 0.02; // pixels per millisecond
// A frame's worth of time when the clock misbehaves (a backgrounded tab).
const MAX_STEP_MS = 50;

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
    this.inFlight = [];
    this.lagMs = DEFAULT_LAG;
    this.ticking = false;
    this.touching = false;
  }

  // report closes the books on a gesture: what was sent while the finger was
  // down, what the glide added, and how fast it was let go.
  report(at, speed) {
    // The picture belongs to tmux again. What the finger covered beyond the
    // last whole line cannot be drawn at all, so the shift is handed back
    // rather than left as a standing offset — a screen parked half a line off
    // its grid would misplace every tap after it.
    this.inFlight = [];
    if (this.onTrack) this.onTrack(0);
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

  // How long a notch takes to come back as a redrawn screen. Measured by the
  // page on the live connection; the page also batches a frame's notches into
  // one message, so what arrives here is a frame short of the whole trip.
  setLag(ms) {
    this.lagMs = Math.max(16, Math.min(200, ms || DEFAULT_LAG));
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
  // A notch is counted as drawn on a clock rather than on the redraw itself.
  // Frames arriving from the server are not attributable: under an agent the
  // pane redraws on its own, and taking any of those as the answer would drop
  // the shift while the content had not moved. A clock can be wrong by the
  // error in lagMs; the redraw heuristic is wrong whenever anything else is
  // printing, which here is most of the time.
  track(at) {
    // Only while the finger is down. A frame already queued when the finger
    // lifts would otherwise put the shift back for one frame after the gesture
    // handed it over — a flick that twitched once as it started.
    if (!this.onTrack || !this.touching) return;
    while (this.inFlight.length && at - this.inFlight[0].at >= this.lagMs) this.inFlight.shift();
    let owed = 0;
    for (const f of this.inFlight) owed += f.dir;
    const limit = MAX_TRACK * this.pixelsPerNotch;
    const px = this.carry + owed * this.pixelsPerNotch;
    this.onTrack(Math.max(-limit, Math.min(limit, px)));
    // A notch in flight stops being owed on a clock, so the shift has to be
    // revisited even while the finger holds still.
    if (this.inFlight.length && !this.gliding && !this.ticking) {
      this.ticking = true;
      this.raf((t) => { this.ticking = false; this.track(t); });
    }
  }

  start(at) {
    this.gliding = false; // a touch always catches the glide
    this.touching = true;
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
  // The shift goes back here, before the glide rather than after it. Covering
  // the glide as well was the first thing tried and it juddered: a flick at
  // 1.4 px/ms has two or three notches in the air at once, the cover then runs
  // into MAX_TRACK, and a shift that stops following and then catches up is the
  // stutter it was supposed to remove. Under a finger there is at most one
  // notch outstanding, which is the case worth covering — and nobody can judge
  // a fraction of a line at flick speed anyway.
  end(at) {
    this.touching = false;
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
    this.inFlight = [];
    if (this.onTrack) this.onTrack(0);
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
    this.raf((t) => this.glide(t));
  }

  stop() {
    this.gliding = false;
    this.speed = 0;
  }

  // at is when the movement happened, so a notch can be remembered as owed
  // until tmux has had time to draw it.
  emit(dy, at = 0) {
    this.carry += dy;
    while (this.carry >= this.pixelsPerNotch) {
      this.carry -= this.pixelsPerNotch;
      this.notches++;
      this.inFlight.push({ at, dir: 1 });
      this.notch(1);
    }
    while (this.carry <= -this.pixelsPerNotch) {
      this.carry += this.pixelsPerNotch;
      this.notches++;
      this.inFlight.push({ at, dir: -1 });
      this.notch(-1);
    }
  }
}
