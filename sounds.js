// ═══════════════════════════════════════════
//  SOUNDS — Web Audio API (no files needed)
// ═══════════════════════════════════════════
const SFX = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function play(freq, type, duration, vol = 0.3, delay = 0) {
    try {
      const c = getCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type; o.frequency.value = freq;
      const t = c.currentTime + delay;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      o.start(t); o.stop(t + duration);
    } catch(e) {}
  }

  function noise(duration, vol = 0.15) {
    try {
      const c = getCtx();
      const buf = c.createBuffer(1, c.sampleRate * duration, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf; src.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
      src.start(); src.stop(c.currentTime + duration);
    } catch(e) {}
  }

  return {
    // Card deal: short crisp tick
    deal() { noise(0.04, 0.2); },

    // Chip: higher frequency click
    chip() { play(800, 'square', 0.06, 0.15); },

    // Chips sliding into pot
    chipSlide() {
      for (let i = 0; i < 4; i++) {
        setTimeout(() => { play(600 + i*80, 'square', 0.05, 0.1); noise(0.03, 0.08); }, i * 60);
      }
    },

    // Check: soft thud
    check() { play(200, 'sine', 0.12, 0.2); },

    // Fold: descending
    fold() { play(300, 'triangle', 0.08, 0.15); play(220, 'triangle', 0.08, 0.15, 0.1); },

    // Win: ascending fanfare
    win() {
      [[523,0],[659,0.1],[784,0.2],[1047,0.3]].forEach(([f,d]) =>
        play(f, 'sine', 0.3, 0.35, d)
      );
    },

    // New hand: card shuffle feel
    shuffle() {
      for (let i = 0; i < 8; i++) {
        setTimeout(() => noise(0.03, 0.12), i * 50);
      }
    },

    // Your turn: attention ping
    yourTurn() { play(880, 'sine', 0.15, 0.25); play(1100, 'sine', 0.12, 0.12, 0.18); },
  };
})();
