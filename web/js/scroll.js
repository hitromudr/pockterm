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
  constructor({ notch, now = () => Date.now(), raf = (fn) => requestAnimationFrame(fn) }) {
    this.notch = notch;
    this.now = now;
    this.raf = raf;
    this.pixelsPerNotch = 1;
    this.carry = 0;
    this.speed = 0;
    this.lastAt = 0;
    this.gliding = false;
  }

  // How many pixels of travel make one notch: the row height times the lines
  // tmux moves per notch.
  setStep(pixels) {
    this.pixelsPerNotch = Math.max(1, pixels);
  }

  start(at) {
    this.gliding = false; // a touch always catches the glide
    this.carry = 0;
    this.speed = 0;
    this.lastAt = at;
  }

  // dy is the movement since the last call, in pixels; positive = downwards
  // (towards older output).
  move(dy, at) {
    this.emit(dy);
    const dt = Math.max(1, at - this.lastAt);
    this.lastAt = at;
    // Smoothed, so one jittery sample does not decide the whole flick.
    const sample = dy / dt;
    this.speed = this.speed === 0 ? sample : this.speed * 0.7 + sample * 0.3;
  }

  // Let go: keep going if the finger was still moving.
  end(at) {
    if (at - this.lastAt > 100) this.speed = 0; // held still before lifting
    if (Math.abs(this.speed) < MIN_SPEED) return;
    this.gliding = true;
    this.lastAt = at;
    this.raf((t) => this.glide(t));
  }

  glide(at) {
    if (!this.gliding) return;
    const dt = Math.min(MAX_STEP_MS, Math.max(1, at - this.lastAt));
    this.lastAt = at;
    this.emit(this.speed * dt);
    this.speed *= Math.pow(FRICTION, dt / 16.7);
    if (Math.abs(this.speed) < MIN_SPEED) { this.gliding = false; return; }
    this.raf((t) => this.glide(t));
  }

  stop() {
    this.gliding = false;
    this.speed = 0;
  }

  emit(dy) {
    this.carry += dy;
    while (this.carry >= this.pixelsPerNotch) {
      this.carry -= this.pixelsPerNotch;
      this.notch(1);
    }
    while (this.carry <= -this.pixelsPerNotch) {
      this.carry += this.pixelsPerNotch;
      this.notch(-1);
    }
  }
}
