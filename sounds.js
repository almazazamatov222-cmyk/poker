// ═══ SOUNDS — realistic poker sounds via Web Audio API ═══
const SFX = (() => {
  let ctx = null;
  function C() {
    if (!ctx) { try { ctx = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){} }
    return ctx;
  }

  // Resume context on first user gesture
  document.addEventListener('click', () => { try { C()?.resume(); } catch(e){} }, { once: true });

  function now() { return C()?.currentTime || 0; }

  // Low-level: oscillator with gain envelope
  function osc(freq, type, t0, attack, sustain, release, vol, dest) {
    const c = C(); if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g); g.connect(dest || c.destination);
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.setValueAtTime(vol, t0 + attack + sustain);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + sustain + release);
    o.start(t0); o.stop(t0 + attack + sustain + release + 0.01);
  }

  // Low-level: white noise burst
  function noiseBurst(t0, dur, vol, lpFreq, dest) {
    const c = C(); if (!c) return;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1);
    const src = c.createBufferSource();
    const lpf = c.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = lpFreq || 8000;
    const g = c.createGain();
    src.buffer = buf; src.connect(lpf); lpf.connect(g); g.connect(dest || c.destination);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.start(t0); src.stop(t0 + dur + 0.01);
  }

  // Compressor for final mix
  function mkComp() {
    const c = C(); if (!c) return c.destination;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 6;
    comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.1;
    comp.connect(c.destination); return comp;
  }

  return {
    // Card deal — sharp slap like plastic card on felt
    deal() {
      const t = now();
      noiseBurst(t,      0.008, 0.6, 12000);   // initial crack
      noiseBurst(t+0.004, 0.04, 0.25, 3000);   // body thud
      osc(180, 'sine', t, 0.001, 0.01, 0.06, 0.12);
    },

    // Single chip click — metallic resonance
    chip() {
      const t = now();
      osc(1400, 'triangle', t, 0.001, 0.002, 0.055, 0.18);
      osc(900,  'triangle', t, 0.001, 0.002, 0.04,  0.10);
      noiseBurst(t, 0.008, 0.08, 5000);
    },

    // Chips sliding into pot — cascade of clicks
    chipSlide() {
      const count = 8;
      for (let i = 0; i < count; i++) {
        const t = now() + i * 0.055;
        const f = 900 + Math.random() * 600;
        osc(f, 'triangle', t, 0.001, 0.001, 0.04, 0.12);
        noiseBurst(t, 0.006, 0.06, 4000);
      }
    },

    // Check — soft table knock
    check() {
      const t = now();
      osc(120, 'sine', t, 0.003, 0.005, 0.12, 0.25);
      noiseBurst(t, 0.015, 0.12, 600);
    },

    // Fold — card slide + thud
    fold() {
      const t = now();
      noiseBurst(t,      0.06, 0.2, 4000);
      noiseBurst(t+0.05, 0.04, 0.15, 800);
      osc(90, 'sine', t+0.05, 0.002, 0.005, 0.08, 0.1);
    },

    // New hand — card shuffle
    shuffle() {
      for (let i = 0; i < 10; i++) {
        const t = now() + i * 0.045;
        noiseBurst(t, 0.025, 0.12 + Math.random()*0.08, 6000);
      }
    },

    // Win — coins + fanfare
    win() {
      // Coin shower
      for (let i = 0; i < 12; i++) {
        const t = now() + i * 0.045;
        const f = 800 + Math.random() * 800;
        osc(f, 'triangle', t, 0.001, 0.001, 0.07, 0.14);
        noiseBurst(t, 0.006, 0.06, 5000);
      }
      // Musical fanfare
      const notes = [523, 659, 784, 1047, 1319];
      notes.forEach((f, i) => {
        osc(f, 'sine', now() + 0.15 + i*0.1, 0.01, 0.08, 0.18, 0.28);
        osc(f*2, 'sine', now() + 0.15 + i*0.1, 0.01, 0.08, 0.18, 0.08);
      });
    },

    // Your turn — attention bell
    yourTurn() {
      const t = now();
      osc(1046, 'sine', t,      0.005, 0.04, 0.25, 0.22);
      osc(1318, 'sine', t+0.15, 0.005, 0.03, 0.2,  0.16);
      osc(880,  'sine', t,      0.005, 0.04, 0.25, 0.08);
    },

    // All-in shove — dramatic impact
    allin() {
      const t = now();
      for (let i = 0; i < 20; i++) {
        const ti = t + i * 0.03;
        osc(700 + i*40, 'triangle', ti, 0.001, 0.001, 0.05, 0.13);
        noiseBurst(ti, 0.008, 0.07, 5000);
      }
      osc(80, 'sine', t, 0.005, 0.02, 0.18, 0.3);
    },
  };
})();
