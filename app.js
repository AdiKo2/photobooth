(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  const SHOTS = 3;
  const TIMER_SECONDS = 5;   // Timer mode: automatic countdown before every photo
  const PAUSE_SECONDS = 3;   // Pause mode: short countdown after you press Film / Next
  const PRINT_MS = 4000;

  const video = $('#video');
  const frame = $('#frame');
  const layer = $('#stickerLayer');
  const mask = $('#shapeMask');
  const filmBtn = $('#filmBtn');
  const backBtn = $('#backBtn');
  const countdown = $('#countdown');

  const state = {
    style: null,
    mode: 'timer',      // 'timer' | 'pause'
    tone: 'bw',         // retro film stock
    shape: 'rect',      // kawaii photo shape
    bg: 'dots',         // kawaii strip background
    placed: [],
    stream: null,
    camToken: 0,
    busy: false,
    waitingNext: null,  // resolver while a Pause-mode session waits for Next
    stripUrl: null,
    stripBlob: null,
    stripName: '',
    peer: null,
    printTimer: null,
  };

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }

  /* ================= Fonts ================= */
  const fontsReady = (async () => {
    if (!document.fonts) return;
    const faces = ['400 40px "Special Elite"', '700 40px Fredoka', '500 40px Fredoka', '400 40px Limelight'];
    try {
      await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), wait(3000)]);
    } catch (_) { /* fall back to system fonts */ }
  })();

  /* ================= Canvas helpers ================= */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // (x, y) is the top centre of the heart; s is its width and height
  function heartPath(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.3);
    ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
    ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
    ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
    ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
    ctx.closePath();
  }
  function starPath(ctx, cx, cy, points, outer, inner) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = (i * Math.PI) / points - Math.PI / 2;
      const r = i % 2 === 0 ? outer : inner;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
  }
  function drawEmoji(ctx, ch, cx, cy, size, rot = 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, size * 0.05);
    ctx.restore();
  }
  // Small seeded random generator, so a background pattern looks the same
  // in its swatch and on the printed strip.
  function seeded(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ================= Kawaii photo shapes ================= */
  // Each shape is an outline of points around (0, 0). shapePoly() scales it to
  // fit a box, so the same outline is used for the live preview
  // overlay and for cutting out photos on the strip.
  function roundedRectPoints(w, h, r) {
    const pts = [];
    const corners = [
      [w / 2 - r, -h / 2 + r, -Math.PI / 2],
      [w / 2 - r, h / 2 - r, 0],
      [-w / 2 + r, h / 2 - r, Math.PI / 2],
      [-w / 2 + r, -h / 2 + r, Math.PI],
    ];
    corners.forEach(([cx, cy, a0]) => {
      for (let i = 0; i <= 8; i++) {
        const a = a0 + (i / 8) * (Math.PI / 2);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    });
    return pts;
  }
  function heartPoints() {
    const pts = [];
    for (let i = 0; i < 160; i++) {
      const t = (i / 160) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      pts.push([x, y]);
    }
    return pts;
  }
  function starPoints() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      const r = i % 2 === 0 ? 1 : 0.52;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  }
  const SHAPES = {
    rect: { label: 'Rectangle', pts: roundedRectPoints(4, 3, 0.25), fill: 1 },
    heart: { label: 'Heart', pts: heartPoints(), fill: 0.96 },
    star: { label: 'Star', pts: starPoints(), fill: 0.98 },
  };

  function shapePoly(shape, w, h) {
    const def = SHAPES[shape];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    def.pts.forEach(([x, y]) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    const k = Math.min(w / (maxX - minX), h / (maxY - minY)) * def.fill;
    const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
    return def.pts.map(([x, y]) => [(x - ox) * k, (y - oy) * k]);
  }
  function tracePoly(ctx, poly, cx, cy) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x, cy + y) : ctx.moveTo(cx + x, cy + y)));
    ctx.closePath();
  }

  /* ================= Kawaii strip backgrounds ================= */
  const BACKGROUNDS = {
    dots: {
      name: 'Pink dots', base: '#ffd6e7', ink: '#ff4f9a', sub: '#c2577f', shadow: '#ff9ec7',
      draw(x, W, H) {
        x.fillStyle = this.base; x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(255,255,255,.7)';
        for (let y = 10, row = 0; y < H; y += 36, row++) {
          for (let xx = row % 2 ? 28 : 10; xx < W; xx += 36) { x.beginPath(); x.arc(xx, y, 4, 0, Math.PI * 2); x.fill(); }
        }
      },
    },
    gingham: {
      name: 'Lavender gingham', base: '#f1e8ff', ink: '#9466f2', sub: '#7a5bb8', shadow: '#cdb6ff',
      draw(x, W, H) {
        x.fillStyle = this.base; x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(170,140,250,.28)';
        for (let i = 0; i < W; i += 48) x.fillRect(i, 0, 24, H);
        for (let i = 0; i < H; i += 48) x.fillRect(0, i, W, 24);
      },
    },
    mint: {
      name: 'Mint stars', base: '#d6f5e8', ink: '#24a87e', sub: '#3c8f73', shadow: '#9fe3c8',
      draw(x, W, H) {
        x.fillStyle = this.base; x.fillRect(0, 0, W, H);
        const rnd = seeded(7);
        for (let i = 0; i < (W * H) / 5200; i++) {
          starPath(x, rnd() * W, rnd() * H, 5, 6 + rnd() * 8, 3 + rnd() * 3);
          x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.9)' : 'rgba(255,214,90,.8)';
          x.fill();
        }
      },
    },
    sky: {
      name: 'Cotton-candy sky', base: '#d4ebff', ink: '#4a8fe0', sub: '#4a74b0', shadow: '#a9d2ff',
      draw(x, W, H) {
        const g = x.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#bfe1ff'); g.addColorStop(1, '#f6e3ff');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        const rnd = seeded(11);
        x.fillStyle = 'rgba(255,255,255,.85)';
        for (let i = 0; i < H / 110; i++) {
          const cx = rnd() * W, cy = rnd() * H, s = 18 + rnd() * 14;
          [[0, 0, 1.2], [-1.3, 0.3, 0.9], [1.3, 0.3, 0.9], [-0.6, -0.5, 0.9], [0.7, -0.5, 1]].forEach(([dx, dy, r]) => {
            x.beginPath(); x.arc(cx + dx * s, cy + dy * s, r * s, 0, Math.PI * 2); x.fill();
          });
        }
      },
    },
    hearts: {
      name: 'Cream hearts', base: '#fff3e2', ink: '#ff6f91', sub: '#c47a5a', shadow: '#ffd2a8',
      draw(x, W, H) {
        x.fillStyle = this.base; x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(255,140,170,.45)';
        for (let y = 14, row = 0; y < H; y += 46, row++) {
          for (let xx = row % 2 ? 36 : 13; xx < W; xx += 46) { heartPath(x, xx, y, 16); x.fill(); }
        }
      },
    },
    strawberry: {
      name: 'Strawberry milk', base: '#ffe1e9', ink: '#e8436f', sub: '#b04a64', shadow: '#ffb1c4',
      draw(x, W, H) {
        x.fillStyle = this.base; x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(255,255,255,.75)';
        for (let y = 30, row = 0; y < H; y += 80, row++) {
          for (let xx = row % 2 ? 70 : 30; xx < W; xx += 80) {
            x.beginPath(); x.arc(xx + 40, y + 40, 5, 0, Math.PI * 2); x.fill();
            x.save(); x.globalAlpha = 0.55; drawEmoji(x, '🍓', xx, y, 26, row % 2 ? 0.3 : -0.3); x.restore();
          }
        }
      },
    },
  };

  /* ================= Sticker definitions ================= */
  // Each sticker is drawn once to its own canvas. The same canvas is shown on the
  // live preview (as an <img>) and drawn onto the captured photos.
  const emojiSticker = (ch, size = 0.16) => ({
    w: 160, h: 160, size,
    draw(c, w, h) { drawEmoji(c, ch, w / 2, h / 2, h * 0.8); },
  });

  const KAWAII = [
    {
      name: 'Cat ears', w: 320, h: 130, size: 0.42, y: 0.16,
      draw(c, w, h) {
        c.lineJoin = 'round';
        const ear = (cx, tilt) => {
          c.fillStyle = '#2b2b2b'; c.strokeStyle = '#2b2b2b'; c.lineWidth = 14;
          c.beginPath(); c.moveTo(cx - 48, h - 12); c.lineTo(cx + tilt, 14); c.lineTo(cx + 48, h - 12); c.closePath();
          c.fill(); c.stroke();
          c.fillStyle = '#ff9ec7';
          c.beginPath(); c.moveTo(cx - 26, h - 18); c.lineTo(cx + tilt * 0.8, 40); c.lineTo(cx + 26, h - 18); c.closePath();
          c.fill();
        };
        ear(72, -14); ear(w - 72, 14);
      },
    },
    {
      name: 'Bunny ears', w: 260, h: 230, size: 0.36, y: 0.14,
      draw(c, w, h) {
        const ear = (cx, rot) => {
          c.save(); c.translate(cx, h * 0.55); c.rotate(rot);
          c.fillStyle = '#fff'; c.strokeStyle = '#f3c6d8'; c.lineWidth = 6;
          c.beginPath(); c.ellipse(0, 0, 36, h * 0.4, 0, 0, Math.PI * 2); c.fill(); c.stroke();
          c.fillStyle = '#ffb3cf';
          c.beginPath(); c.ellipse(0, 8, 17, h * 0.28, 0, 0, Math.PI * 2); c.fill();
          c.restore();
        };
        ear(w * 0.33, -0.2); ear(w * 0.67, 0.2);
      },
    },
    {
      name: 'Heart glasses', w: 300, h: 130, size: 0.36, y: 0.42,
      draw(c, w, h) {
        c.lineWidth = 8; c.strokeStyle = '#ff3d8b'; c.lineCap = 'round';
        c.beginPath(); c.moveTo(30, 48); c.lineTo(6, 34); c.moveTo(w - 30, 48); c.lineTo(w - 6, 34); c.stroke();
        c.beginPath(); c.moveTo(132, 50); c.quadraticCurveTo(150, 34, 168, 50); c.stroke();
        [82, w - 82].forEach((x) => {
          heartPath(c, x, 14, 104);
          c.fillStyle = 'rgba(255, 90, 150, .55)'; c.fill(); c.stroke();
        });
        c.fillStyle = 'rgba(255,255,255,.7)';
        c.beginPath(); c.ellipse(62, 44, 9, 5, -0.6, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.ellipse(w - 102, 44, 9, 5, -0.6, 0, Math.PI * 2); c.fill();
      },
    },
    {
      name: 'Blush', w: 300, h: 80, size: 0.38, y: 0.56,
      draw(c, w, h) {
        c.fillStyle = 'rgba(255, 110, 160, .55)';
        [52, w - 52].forEach((x) => { c.beginPath(); c.ellipse(x, h / 2, 44, 22, 0, 0, Math.PI * 2); c.fill(); });
        c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 4; c.lineCap = 'round';
        [52, w - 52].forEach((x) => {
          for (let i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(x + i * 14 - 4, h / 2 + 8); c.lineTo(x + i * 14 + 4, h / 2 - 8); c.stroke(); }
        });
      },
    },
    {
      name: 'Speech bubble', w: 270, h: 150, size: 0.28,
      draw(c, w, h) {
        c.fillStyle = '#fff'; c.strokeStyle = '#ff4f9a'; c.lineWidth = 6; c.lineJoin = 'round';
        roundRect(c, 6, 6, w - 12, h - 40, 40); c.fill(); c.stroke();
        c.beginPath(); c.moveTo(60, h - 37); c.lineTo(46, h - 6); c.lineTo(96, h - 37); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.fillRect(63, h - 42, 30, 8);
        c.fillStyle = '#ff4f9a'; c.font = '700 48px Fredoka, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('kawaii!', w / 2, (h - 34) / 2 + 4);
      },
    },
    { name: 'Bow', ...emojiSticker('🎀', 0.2) },
    { name: 'Crown', ...emojiSticker('👑', 0.2) },
    { name: 'Sparkles', ...emojiSticker('✨') },
    { name: 'Heart', ...emojiSticker('💖') },
    { name: 'Flower', ...emojiSticker('🌸') },
    { name: 'Strawberry', ...emojiSticker('🍓') },
    { name: 'Teddy', ...emojiSticker('🧸', 0.2) },
  ];

  let assetsBuilt = false;
  function buildAssets() {
    if (assetsBuilt) return;
    KAWAII.forEach((def) => {
      def.canvas = makeCanvas(def.w, def.h);
      def.draw(def.canvas.getContext('2d'), def.w, def.h);
      def.src = def.canvas.toDataURL('image/png');
      def.aspect = def.h / def.w;
    });
    Object.values(BACKGROUNDS).forEach((bg) => {
      const c = makeCanvas(120, 160), x = c.getContext('2d');
      x.scale(0.25, 0.25);
      bg.draw(x, 480, 640);
      bg.swatch = c.toDataURL('image/png');
    });
    assetsBuilt = true;
  }

  /* ================= Booth styles ================= */
  const FILM_STOCKS = {
    bw: { label: 'Black & white', name: 'B&W 400', filter: 'grayscale(1) contrast(1.25) brightness(1.05)', hint: 'Classic high-contrast black & white.' },
    sepia: { label: 'Sepia', name: 'SEPIA', filter: 'sepia(.85) contrast(1.15) brightness(1.02)', hint: 'Warm brown tones, like an old family album.' },
    soft: { label: 'Soft 35mm', name: 'SOFT 35MM', filter: 'saturate(.72) contrast(.82) brightness(1.12) sepia(.12)', hint: 'Pastel colors, faded blacks and a gentle warm glow.' },
    lofi: { label: 'Lo-fi', name: 'LO-FI', filter: 'sepia(.55) hue-rotate(230deg) saturate(1.35) contrast(1.3) brightness(.9)', hint: 'Dreamy purple toy-camera tones, heavy grain and pink light leaks.' },
  };

  const STYLES = {
    retro: { title: 'Retro Film Booth', filter: () => FILM_STOCKS[state.tone].filter },
    kawaii: { title: 'Kawaii Booth ♡', filter: () => 'saturate(1.15) brightness(1.1) contrast(.95)' },
  };

  function applyPreviewFilter() {
    video.style.filter = STYLES[state.style].filter();
    document.body.dataset.tone = state.tone; // lets the CSS thicken the live grain for Lo-fi
  }

  /* ================= Side panel ================= */
  function segmented(options, current, onPick, cls = '') {
    const wrap = document.createElement('div');
    wrap.className = `seg ${cls}`;
    const sync = (val) => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === val)));
    Object.entries(options).forEach(([val, label]) => {
      const b = document.createElement('button');
      b.dataset.val = val;
      b.textContent = label;
      b.addEventListener('click', () => { sync(val); onPick(val); });
      wrap.append(b);
    });
    sync(current);
    return wrap;
  }
  function heading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
  }
  function hint(text) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    return p;
  }

  const MODE_HINTS = {
    timer: `Hands-free: a ${TIMER_SECONDS}-second countdown before each of the ${SHOTS} photos.`,
    pause: `The booth pauses after each photo. Press Next when you’re ready (${PAUSE_SECONDS}-second countdown).`,
  };

  function buildPalette(style) {
    const p = $('#palette');
    p.innerHTML = '';

    // Shutter mode: shared by both booths
    const modeHint = hint(MODE_HINTS[state.mode]);
    p.append(
      heading('Shutter'),
      segmented({ timer: '⏱ Timer', pause: '⏸ Pause' }, state.mode, (v) => {
        state.mode = v;
        modeHint.textContent = MODE_HINTS[v];
      }),
      modeHint,
    );

    if (style === 'retro') {
      const stockHint = hint(FILM_STOCKS[state.tone].hint);
      const labels = Object.fromEntries(Object.entries(FILM_STOCKS).map(([k, v]) => [k, v.label]));
      p.append(
        heading('Film stock'),
        segmented(labels, state.tone, (v) => {
          state.tone = v;
          stockHint.textContent = FILM_STOCKS[v].hint;
          applyPreviewFilter();
        }),
        stockHint,
      );
      return;
    }

    // Kawaii: photo shape
    const shapeLabels = Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, v.label]));
    p.append(
      heading('Photo shape'),
      segmented(shapeLabels, state.shape, (v) => { state.shape = v; drawShapeMask(); }, 'three'),
    );

    // Kawaii: strip background
    const sw = document.createElement('div');
    sw.className = 'swatches';
    Object.entries(BACKGROUNDS).forEach(([key, bg]) => {
      const b = document.createElement('button');
      b.title = bg.name;
      b.setAttribute('aria-label', `${bg.name} background`);
      b.setAttribute('aria-pressed', String(key === state.bg));
      b.innerHTML = `<img alt="" src="${bg.swatch}">`;
      b.addEventListener('click', () => {
        state.bg = key;
        sw.querySelectorAll('button').forEach((q) => q.setAttribute('aria-pressed', String(q === b)));
        bgName.textContent = bg.name;
        drawShapeMask();
      });
      sw.append(b);
    });
    const bgName = hint(BACKGROUNDS[state.bg].name);
    p.append(heading('Strip background'), bgName, sw);

    // Kawaii: props
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    KAWAII.forEach((def) => {
      const b = document.createElement('button');
      b.title = def.name;
      b.setAttribute('aria-label', `Add ${def.name}`);
      b.innerHTML = `<img alt="" src="${def.src}">`;
      b.addEventListener('click', () => addSticker(def));
      grid.append(b);
    });
    const clear = document.createElement('button');
    clear.className = 'btn ghost small clear';
    clear.textContent = 'Clear all props';
    clear.addEventListener('click', clearPlaced);
    p.append(
      heading('Props'),
      hint('Tap to add. Drag to move, pull the corner dot to resize, spin the ↻ handle to rotate, × to remove.'),
      grid,
      clear,
    );
  }

  // Shades everything outside the chosen shape, in the strip's background color,
  // so you can line yourself up inside the heart / star.
  function drawShapeMask() {
    if (state.style !== 'kawaii') { mask.hidden = true; return; }
    mask.hidden = false;
    const w = mask.clientWidth, h = mask.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    mask.width = Math.round(w * dpr);
    mask.height = Math.round(h * dpr);
    const x = mask.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const poly = shapePoly(state.shape, w, h);
    x.globalAlpha = 0.85;
    x.fillStyle = BACKGROUNDS[state.bg].base;
    x.fillRect(0, 0, w, h);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'destination-out';
    tracePoly(x, poly, w / 2, h / 2);
    x.fill();
    x.globalCompositeOperation = 'source-over';
    x.setLineDash([8, 6]);
    x.lineWidth = 2;
    x.strokeStyle = BACKGROUNDS[state.bg].ink;
    x.stroke();
  }
  new ResizeObserver(() => drawShapeMask()).observe(frame);

  /* ================= Placed stickers ================= */
  function positionSticker(p) {
    p.el.style.left = `${p.x * 100}%`;
    p.el.style.top = `${p.y * 100}%`;
    p.el.style.width = `${p.w * 100}%`;
    p.el.style.transform = `translate(-50%, -50%) rotate(${p.r}deg)`;
  }
  function select(p) {
    state.placed.forEach((q) => q.el.classList.toggle('sel', q === p));
  }
  function addSticker(def) {
    const p = {
      def,
      x: clamp(0.5 + (Math.random() - 0.5) * (def.y ? 0 : 0.5), 0.1, 0.9),
      y: def.y ?? clamp(0.3 + Math.random() * 0.4, 0, 1),
      w: def.size,
      r: 0, // rotation in degrees
    };
    const el = document.createElement('div');
    el.className = 'placed';
    el.innerHTML = `<img alt="${def.name}" src="${def.src}"><button class="rm" aria-label="Remove ${def.name}">×</button><span class="rs" title="Resize"></span><span class="rt" title="Rotate">↻</span>`;
    p.el = el;
    state.placed.push(p);
    layer.append(el);
    positionSticker(p);
    select(p);

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.rm')) return;
      e.preventDefault();
      select(p);
      const rect = layer.getBoundingClientRect();
      const resizing = e.target.classList.contains('rs');
      const rotating = e.target.classList.contains('rt');
      const box = el.getBoundingClientRect(); // its centre stays put however it's rotated
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      const angle = (ev) => (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
      const start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y, w: p.w, r: p.r, a: angle(e) };
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / rect.width;
        const dy = (ev.clientY - start.y) / rect.height;
        if (rotating) {
          let r = start.r + angle(ev) - start.a;
          r = ((r + 540) % 360) - 180;      // keep it within -180..180
          p.r = Math.abs(r) < 5 ? 0 : r;    // snap back to straight
        } else if (resizing) p.w = clamp(start.w + dx * 2, 0.06, 0.95);
        else { p.x = clamp(start.px + dx, 0, 1); p.y = clamp(start.py + dy, 0, 1); }
        positionSticker(p);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.querySelector('.rm').addEventListener('click', () => {
      el.remove();
      state.placed = state.placed.filter((q) => q !== p);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY || e.deltaX;
      if (e.shiftKey) p.r = ((p.r + (delta > 0 ? 5 : -5) + 540) % 360) - 180; // Shift + scroll rotates
      else p.w = clamp(p.w * (delta < 0 ? 1.06 : 0.94), 0.06, 0.95);
      positionSticker(p);
    }, { passive: false });
  }
  function clearPlaced() {
    state.placed.forEach((p) => p.el.remove());
    state.placed = [];
  }
  layer.addEventListener('pointerdown', (e) => { if (e.target === layer) select(null); });

  /* ================= Camera ================= */
  function camFail(msg) {
    const err = $('#camError');
    err.textContent = msg;
    err.hidden = false;
    filmBtn.disabled = true;
  }
  async function startCamera() {
    const token = ++state.camToken;
    $('#camError').hidden = true;
    filmBtn.disabled = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camFail('The camera is only available on https:// pages or http://localhost. Open the site that way and try again.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      if (token !== state.camToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.stream = stream;
      video.srcObject = stream;
      if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
      await video.play().catch(() => {});
      if (token === state.camToken) filmBtn.disabled = false;
    } catch (e) {
      if (token !== state.camToken) return;
      camFail(e && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera in your browser’s address bar, then come back into the booth.'
        : 'No camera found, or another app is using it.');
    }
  }
  function stopCamera() {
    state.camToken++;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
  }

  /* ================= Sound ================= */
  let actx = null;
  function audio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (_) { actx = null; }
    return actx;
  }
  function beep(freq) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.12, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.12);
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.13);
  }
  function shutter() {
    const a = audio(); if (!a) return;
    const len = Math.floor(a.sampleRate * 0.14);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = 2400; g.gain.value = 0.5;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  }

  /* ================= Capture ================= */
  const PHOTO_W = 960, PHOTO_H = 720;

  function toneImage(ctx, w, h, style) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const tone = state.tone;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (style === 'kawaii') {
        r = r * 0.95 + 26; g = g * 0.95 + 14; b = b * 0.95 + 22;
      } else if (tone === 'bw' || tone === 'sepia') {
        const v = (l - 128) * 1.25 + 128 + (Math.random() - 0.5) * 38;
        if (tone === 'bw') { r = g = b = v; }
        else { r = v * 1.07 + 18; g = v * 0.9 + 8; b = v * 0.68; }
      } else if (tone === 'soft') {
        // pastel 35mm: desaturated, low contrast, lifted blacks, warm-pink cast
        const n = (Math.random() - 0.5) * 16;
        r = l + (r - l) * 0.7; g = l + (g - l) * 0.7; b = l + (b - l) * 0.7;
        r = (r - 128) * 0.78 + 128 + 30 + n;
        g = (g - 128) * 0.78 + 128 + 22 + n;
        b = (b - 128) * 0.78 + 128 + 26 + n;
      } else {
        // lo-fi: punchy contrast, purple cast (violet shadows, lilac-pink highlights), heavy grain
        const n = (Math.random() - 0.5) * 90;
        r = l + (r - l) * 1.25; g = l + (g - l) * 1.25; b = l + (b - l) * 1.25;
        // blend 45% toward a purple duotone (deep violet shadows → lilac highlights)
        const t = l / 255;
        r = r * 0.55 + (55 + t * 190) * 0.45;
        g = g * 0.55 + (12 + t * 170) * 0.45;
        b = b * 0.55 + (95 + t * 160) * 0.45;
        r = (r - 128) * 1.3 + 128 + n;
        g = (g - 128) * 1.25 + 128 + n;
        b = (b - 128) * 1.2 + 128 + n;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps for us
    }
    ctx.putImageData(img, 0, 0);

    const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.7);
    if (style === 'kawaii') { vg.addColorStop(0, 'rgba(255,240,248,0)'); vg.addColorStop(1, 'rgba(255,214,231,.45)'); }
    else if (tone === 'soft') { vg.addColorStop(0, 'rgba(255,236,230,0)'); vg.addColorStop(1, 'rgba(255,226,214,.35)'); }
    else if (tone === 'lofi') { vg.addColorStop(0, 'rgba(40,0,70,0)'); vg.addColorStop(1, 'rgba(40,0,70,.8)'); }
    else { vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.6)'); }
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    if (style === 'retro' && tone === 'lofi') {
      // light leak from a random corner
      const lx = Math.random() < 0.5 ? 0 : w, ly = Math.random() < 0.5 ? 0 : h;
      const leak = ctx.createRadialGradient(lx, ly, 0, lx, ly, w * 0.6);
      leak.addColorStop(0, 'rgba(255,90,210,.7)');
      leak.addColorStop(0.5, 'rgba(150,70,255,.28)');
      leak.addColorStop(1, 'rgba(150,70,255,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = leak;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // coarse film grain: low-res noise stretched up gives clumpy grain on top of the fine grain
      const gw = Math.round(w / 2.5), gh = Math.round(h / 2.5);
      const grain = makeCanvas(gw, gh), gx = grain.getContext('2d');
      const gd = gx.createImageData(gw, gh);
      for (let i = 0; i < gd.data.length; i += 4) {
        const v = Math.random() * 255;
        gd.data[i] = gd.data[i + 1] = gd.data[i + 2] = v;
        gd.data[i + 3] = 255;
      }
      gx.putImageData(gd, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.45;
      ctx.drawImage(grain, 0, 0, w, h);
      ctx.restore();
    }
  }

  // Crops the camera frame to 4:3 exactly as object-fit: cover does on screen,
  // so stickers land in the same spot they were placed.
  function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight, target = 4 / 3;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (vw / vh > target) { sw = vh * target; sx = (vw - sw) / 2; }
    else { sh = vw / target; sy = (vh - sh) / 2; }

    const c = makeCanvas(PHOTO_W, PHOTO_H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.save();
    ctx.translate(PHOTO_W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, PHOTO_W, PHOTO_H);
    ctx.restore();
    toneImage(ctx, PHOTO_W, PHOTO_H, state.style);

    state.placed.forEach((p) => {
      const w = p.w * PHOTO_W, h = w * p.def.aspect;
      ctx.save();
      ctx.translate(p.x * PHOTO_W, p.y * PHOTO_H);
      ctx.rotate((p.r * Math.PI) / 180);
      ctx.drawImage(p.def.canvas, -w / 2, -h / 2, w, h);
      ctx.restore();
    });
    return c;
  }

  /* ================= Strip layouts ================= */
  function dateParts() {
    const d = new Date();
    return {
      yy: String(d.getFullYear()).slice(2), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()),
      long: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    };
  }

  function composeRetro(shots) {
    const W = 600, PW = 520, PH = 390, top = 70, gap = 36, bottom = 170;
    const H = top + SHOTS * PH + (SHOTS - 1) * gap + bottom;
    const c = makeCanvas(W, H), x = c.getContext('2d');
    const { yy, mm, dd } = dateParts();

    x.fillStyle = '#0e0c0b'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#e9dfc8';
    for (let y = 14; y < H - 24; y += 40) {
      roundRect(x, 10, y, 16, 22, 4); x.fill();
      roundRect(x, W - 26, y, 16, 22, 4); x.fill();
    }
    const stock = FILM_STOCKS[state.tone].name;
    shots.forEach((s, i) => {
      const y = top + i * (PH + gap);
      x.fillStyle = '#d9a441'; x.font = '15px "Special Elite", monospace'; x.textBaseline = 'alphabetic';
      x.textAlign = 'left'; x.fillText(`▸ ${12 + i * 2}A`, 42, y - 11);
      x.textAlign = 'right'; x.fillText(`${stock} FILM`, W - 42, y - 11);
      x.drawImage(s, 40, y, PW, PH);
      x.save();
      x.font = 'bold 26px "Courier New", monospace'; x.fillStyle = '#ff8a1f';
      x.shadowColor = 'rgba(255,120,20,.9)'; x.shadowBlur = 8; x.textAlign = 'right';
      x.fillText(`'${yy} ${mm} ${dd}`, 40 + PW - 18, y + PH - 18);
      x.restore();
    });
    x.textAlign = 'center';
    x.fillStyle = '#efe6cf'; x.font = '46px "Special Elite", monospace';
    x.fillText('RETRO FILM', W / 2, H - bottom + 88);
    x.fillStyle = '#b9ad93'; x.font = '18px "Special Elite", monospace';
    x.fillText(`EXPOSED ${mm}.${dd}.${yy}  ·  ${stock}`, W / 2, H - bottom + 122);
    return c;
  }

  function composeKawaii(shots) {
    const W = 600, PW = 500, PH = 375, top = 60, gap = 40, bottom = 190, px = 50;
    const H = top + SHOTS * PH + (SHOTS - 1) * gap + bottom;
    const c = makeCanvas(W, H), x = c.getContext('2d');
    const bg = BACKGROUNDS[state.bg];
    const poly = shapePoly(state.shape, PW, PH);

    bg.draw(x, W, H);
    const tl = ['🎀', '🌸', '⭐'], br = ['✨', '💖', '🍓'];
    shots.forEach((s, i) => {
      const y = top + i * (PH + gap);
      const cx = px + PW / 2, cy = y + PH / 2;
      // white frame in the chosen shape, with a soft colored drop
      x.save();
      x.lineJoin = 'round';
      x.shadowColor = bg.shadow; x.shadowOffsetY = 8;
      tracePoly(x, poly, cx, cy);
      x.lineWidth = 24; x.strokeStyle = '#fff'; x.stroke();
      x.restore();
      // the photo, cut to the shape
      x.save();
      tracePoly(x, poly, cx, cy);
      x.clip();
      x.drawImage(s, px, y, PW, PH);
      x.restore();
      drawEmoji(x, tl[i % 3], px + 4, y + 2, 50, -0.3);
      drawEmoji(x, br[i % 3], px + PW - 4, y + PH - 2, 44, 0.25);
    });
    x.fillStyle = bg.ink;
    heartPath(x, 70, H - 140, 46); x.fill();
    heartPath(x, W - 70, H - 140, 46); x.fill();
    x.textAlign = 'center'; x.lineJoin = 'round';
    x.font = '700 58px Fredoka, sans-serif';
    x.lineWidth = 10; x.strokeStyle = '#fff'; x.strokeText('kawaii booth', W / 2, H - bottom + 104);
    x.fillStyle = bg.ink; x.fillText('kawaii booth', W / 2, H - bottom + 104);
    x.font = '500 24px Fredoka, sans-serif'; x.fillStyle = bg.sub;
    x.fillText(`♡ ${dateParts().long} ♡`, W / 2, H - bottom + 144);
    return c;
  }

  async function compose(style, shots) {
    await fontsReady;
    return style === 'retro' ? composeRetro(shots) : composeKawaii(shots);
  }

  /* ================= Shooting session ================= */
  function resetShots() {
    document.querySelectorAll('#shots span').forEach((s) => { s.innerHTML = ''; s.classList.remove('filled'); });
  }
  function fillThumb(i, canvas) {
    const slot = document.querySelectorAll('#shots span')[i];
    if (!slot) return;
    const img = new Image();
    img.alt = `Photo ${i + 1}`;
    img.src = canvas.toDataURL('image/jpeg', 0.7);
    slot.innerHTML = '';
    slot.append(img);
    slot.classList.add('filled');
  }
  function showCount(n, i) {
    countdown.classList.remove('paused');
    countdown.innerHTML = `<div class="num">${n}</div><div class="lbl">Photo ${i + 1} of ${SHOTS}</div>`;
    countdown.classList.add('on');
  }
  function showPaused(i) {
    countdown.innerHTML = `<div class="lbl">⏸ Paused · press Next for photo ${i + 1} of ${SHOTS}</div>`;
    countdown.classList.add('on', 'paused');
  }
  function hideCount() {
    countdown.classList.remove('on', 'paused');
    countdown.innerHTML = '';
  }
  function flash() {
    const f = $('#flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }
  function setFilmButton(label, next = false) {
    filmBtn.textContent = label;
    filmBtn.classList.toggle('next', next);
  }
  function lockPalette(locked) {
    $('#palette').querySelectorAll('.seg button, .swatches button')
      .forEach((b) => { b.disabled = locked; });
  }

  async function shoot() {
    // In Pause mode the Film button turns into "Next" between photos
    if (state.waitingNext) { state.waitingNext(true); return; }
    if (state.busy || !state.stream || !video.videoWidth) return;

    const mode = state.mode;
    const seconds = mode === 'timer' ? TIMER_SECONDS : PAUSE_SECONDS;
    const token = state.camToken;
    const shots = [];
    state.busy = true;
    filmBtn.disabled = true;
    backBtn.disabled = true;
    lockPalette(true);
    frame.classList.add('shooting');
    select(null);
    resetShots();
    try {
      for (let i = 0; i < SHOTS; i++) {
        if (mode === 'pause' && i > 0) {
          // wait here until Next (or the Lobby button) is pressed
          frame.classList.remove('shooting');
          showPaused(i);
          setFilmButton('Next', true);
          filmBtn.disabled = false;
          backBtn.disabled = false;
          const go = await new Promise((r) => { state.waitingNext = r; });
          state.waitingNext = null;
          if (!go || token !== state.camToken) return;
          setFilmButton('Film');
          filmBtn.disabled = true;
          backBtn.disabled = true;
          frame.classList.add('shooting');
          select(null);
        }
        for (let s = seconds; s > 0; s--) {
          if (token !== state.camToken) return;
          showCount(s, i);
          beep(s === 1 ? 1320 : 880);
          await wait(1000);
        }
        if (token !== state.camToken) return;
        hideCount();
        flash();
        shutter();
        const shot = grabFrame();
        shots.push(shot);
        fillThumb(i, shot);
        await wait(700);
      }
      const strip = await compose(state.style, shots);
      await showPrint(strip);
    } finally {
      state.busy = false;
      state.waitingNext = null;
      setFilmButton('Film');
      frame.classList.remove('shooting');
      backBtn.disabled = false;
      filmBtn.disabled = !state.stream;
      lockPalette(false);
      hideCount();
    }
  }

  /* ================= Print + QR ================= */
  async function showPrint(canvas) {
    stopCamera();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (state.stripUrl) URL.revokeObjectURL(state.stripUrl);
    const d = new Date();
    state.stripBlob = blob;
    state.stripUrl = URL.createObjectURL(blob);
    state.stripName = `photobooth-${state.style}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;

    const img = $('#stripImg');
    img.src = state.stripUrl;
    try { await img.decode(); } catch (_) { /* still shows once loaded */ }
    const dl = $('#downloadBtn');
    dl.href = state.stripUrl;
    dl.download = state.stripName;

    const printer = $('#printer');
    const takeHome = $('#takeHome');
    printer.classList.remove('printing', 'done');
    $('.printer-label').textContent = 'Printing…';
    takeHome.classList.remove('show');
    show('print');
    void printer.offsetWidth;
    printer.classList.add('printing');
    startShare();

    clearTimeout(state.printTimer);
    state.printTimer = setTimeout(() => {
      printer.classList.add('done');
      $('.printer-label').textContent = 'Ready';
      takeHome.classList.add('show');
    }, PRINT_MS);
  }

  function setQrStatus(msg) { $('#qrStatus').textContent = msg; }

  function stopShare() {
    if (state.peer) { try { state.peer.destroy(); } catch (_) { /* ignore */ } }
    state.peer = null;
  }

  // The QR code links back to this same page with ?get=<peer id>. When the phone
  // opens it, the phone connects straight to this tab over WebRTC and the strip is
  // sent device-to-device. PeerJS's free public server only introduces the two;
  // the photo is never uploaded or stored anywhere.
  function startShare() {
    stopShare();
    const qrEl = $('#qr');
    qrEl.innerHTML = '';

    if (location.protocol === 'file:') {
      setQrStatus('The QR code needs the site to be online (for example GitHub Pages or Netlify). Use Download for now.');
      return;
    }
    if (!window.Peer || !window.QRCode) {
      setQrStatus('Couldn’t load the sharing tools (are you offline?). Use Download instead.');
      return;
    }
    setQrStatus('Preparing your QR code…');
    const peer = new window.Peer();
    state.peer = peer;

    peer.on('open', (id) => {
      if (state.peer !== peer) return;
      const url = `${location.origin}${location.pathname}?get=${encodeURIComponent(id)}`;
      new window.QRCode(qrEl, { text: url, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      setQrStatus(local
        ? 'Heads up: this link points to localhost, which your phone can’t open. Put the site online to use the QR code.'
        : 'Keep this page open until the photo shows up on your phone.');
    });

    peer.on('connection', (conn) => {
      conn.on('open', async () => {
        setQrStatus('Phone connected, sending…');
        try {
          const buf = await state.stripBlob.arrayBuffer();
          conn.send({ kind: 'strip', name: state.stripName, type: state.stripBlob.type, data: buf });
          setQrStatus('Sent to your phone ✓ Scan again to send it to another phone.');
        } catch (_) {
          setQrStatus('Sending failed. Use Download instead.');
        }
      });
    });

    peer.on('error', (err) => {
      if (state.peer !== peer) return;
      setQrStatus(`Phone sharing isn’t available right now (${err.type || 'network error'}). Use Download instead.`);
    });
  }

  /* ================= Phone side ================= */
  function receiveMode(id) {
    show('receive');
    const status = $('#rxStatus');
    if (!window.Peer) {
      status.textContent = 'Couldn’t load the sharing tools. Check your connection and scan again.';
      return;
    }
    let got = false;
    const peer = new window.Peer();
    const timeout = setTimeout(() => {
      if (!got) status.textContent = 'Still waiting… Make sure the booth page is still open on the other screen, then scan again.';
    }, 20000);

    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true });
      conn.on('open', () => { status.textContent = 'Connected! Receiving your strip…'; });
      conn.on('data', (msg) => {
        if (!msg || msg.kind !== 'strip') return;
        got = true;
        clearTimeout(timeout);
        const type = msg.type || 'image/jpeg';
        const blob = new Blob([msg.data], { type });
        const url = URL.createObjectURL(blob);
        const name = msg.name || 'photobooth.jpg';

        const img = $('#rxImg');
        img.src = url;
        img.hidden = false;
        const dl = $('#rxDownload');
        dl.href = url;
        dl.download = name;
        $('#rxActions').hidden = false;
        $('#rxHint').hidden = false;
        status.textContent = 'Here it is!';

        const file = new File([blob], name, { type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          const share = $('#rxShare');
          share.hidden = false;
          share.onclick = () => navigator.share({ files: [file], title: 'My photo strip' }).catch(() => {});
        }
        setTimeout(() => peer.destroy(), 1000);
      });
    });
    peer.on('error', (err) => {
      if (got) return;
      status.textContent = err.type === 'peer-unavailable'
        ? 'This QR code has expired. Ask the booth to show a new one.'
        : 'Couldn’t reach the booth. Make sure the booth page is still open, then scan again.';
    });
  }

  /* ================= Navigation ================= */
  async function enterBooth(style) {
    state.style = style;
    document.body.dataset.theme = style;
    $('#boothTitle').textContent = STYLES[style].title;
    await fontsReady;
    buildAssets();
    clearPlaced();
    resetShots();
    buildPalette(style);
    applyPreviewFilter();
    show('booth');
    drawShapeMask();
    startCamera();
  }

  function goLobby() {
    if (state.waitingNext) state.waitingNext(false);
    clearTimeout(state.printTimer);
    stopShare();
    stopCamera();
    hideCount();
    delete document.body.dataset.theme;
    show('lobby');
  }

  let opening = false;
  document.querySelectorAll('.booth').forEach((b) => {
    b.addEventListener('click', () => {
      if (opening) return;
      opening = true;
      audio(); // unlock sound while we have a user gesture
      b.classList.add('open');
      setTimeout(async () => {
        await enterBooth(b.dataset.style);
        b.classList.remove('open');
        opening = false;
      }, 950);
    });
  });

  filmBtn.addEventListener('click', () => { audio(); shoot(); });
  backBtn.addEventListener('click', goLobby);
  $('#lobbyBtn').addEventListener('click', goLobby);
  $('#againBtn').addEventListener('click', () => {
    clearTimeout(state.printTimer);
    stopShare();
    resetShots();
    show('booth');
    drawShapeMask();
    startCamera();
  });

  /* ================= Start ================= */
  const getId = new URLSearchParams(location.search).get('get');
  if (getId) receiveMode(getId);
  else show('lobby');
})();
