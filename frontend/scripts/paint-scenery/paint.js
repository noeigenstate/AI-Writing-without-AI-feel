/* In-page painting library for the offline scenery generator (runs in headless Chrome, never in the app).
 *
 * `Painter(W, H, S)` owns a canvas of W×H pixels; shapes are given in "design units" (S pixels each) as SVG path data.
 * It simulates three media:
 *   wash()    transparent watercolour: wobbling soft/crisp mixed edges, pigment pooled at the edge, blotchy colour, granulation
 *   gouache() opaque matte paint: flatter, denser colour, brush-direction streaks, a crisp rough edge
 *   crown()   foliage painted as many dabbed leaf strokes with lit tops and cool shadowed undersides
 * plus cumulus(), blades(), pencil(), vignette() and finish() (paper grain).
 */
(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNoise(seed) {
    const r = mulberry(seed);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const grad = (h, x, y) => {
      switch (h & 7) {
        case 0: return x + y;
        case 1: return x - y;
        case 2: return -x + y;
        case 3: return -x - y;
        case 4: return x;
        case 5: return -x;
        case 6: return y;
        default: return -y;
      }
    };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const X = xi & 255, Y = yi & 255;
      const u = fade(xf), v = fade(yf);
      const aa = p[p[X] + Y], ab = p[p[X] + Y + 1], ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
      const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
      const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
      return lerp(x1, x2, v);
    };
  }

  function fbm(noise, x, y, oct) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let i = 0; i < oct; i++) {
      sum += noise(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return clamp(0.5 + 0.5 * (sum / norm) * 1.35, 0, 1);
  }

  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  const svgNS = 'http://www.w3.org/2000/svg';
  const pathEl = document.createElementNS(svgNS, 'path');

  /** Sample SVG path data (one polygon per subpath) in design units. */
  function samplePolys(d, step) {
    const parts = d.split(/(?=M)/).filter((s) => s.trim());
    const out = [];
    for (const part of parts) {
      pathEl.setAttribute('d', part);
      const len = pathEl.getTotalLength();
      if (!len) continue;
      const n = Math.max(10, Math.ceil(len / step));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const q = pathEl.getPointAtLength((len * i) / n);
        pts.push([q.x, q.y]);
      }
      out.push(pts);
    }
    return out;
  }

  function Painter(W, H, S, seed) {
    seed = seed || 1;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const N = makeNoise(seed * 97 + 3);
    const R = mulberry(seed * 31 + 7);
    let T = null;

    function tex() {
      if (T) return T;
      const n = W * H;
      T = { b1: new Float32Array(n), b2: new Float32Array(n), st: new Float32Array(n), sv: new Float32Array(n), gr: new Float32Array(n), hf: new Float32Array(n) };
      const r = mulberry(seed * 13 + 5);
      for (let y = 0; y < H; y++) {
        const yd = y / S;
        for (let x = 0; x < W; x++) {
          const xd = x / S;
          const i = y * W + x;
          T.b1[i] = fbm(N, xd / 110, yd / 110, 4);
          T.b2[i] = fbm(N, xd / 38 + 40, yd / 38 + 11, 3);
          T.st[i] = fbm(N, xd / 200 + 7, yd / 18 + 3, 3);
          T.sv[i] = fbm(N, xd / 10 + 21, yd / 150 + 9, 3);
          T.hf[i] = r();
          T.gr[i] = clamp(r() * 0.3 + fbm(N, x / 2.6 + 70, y / 2.6, 3) * 0.7, 0, 1);
        }
      }
      return T;
    }

    function polysFor(d, o) {
      o = o || {};
      let polys = samplePolys(d, o.step || 4);
      const amp = o.wob == null ? 3 : o.wob;
      const f = o.wf || 0.03;
      if (amp > 0) {
        polys = polys.map((poly) =>
          poly.map(([x, y]) => [
            x + (N(x * f + 17, y * f) - 0.0) * amp * 1.6,
            y + (N(x * f, y * f + 53) - 0.0) * amp * 1.6,
          ])
        );
      }
      return polys;
    }

    function bboxOf(polys, pad) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const poly of polys) for (const [x, y] of poly) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      const bx = clamp(Math.floor(x0 * S - pad), 0, W), by = clamp(Math.floor(y0 * S - pad), 0, H);
      const ex = clamp(Math.ceil(x1 * S + pad), 0, W), ey = clamp(Math.ceil(y1 * S + pad), 0, H);
      return { bx, by, bw: Math.max(0, ex - bx), bh: Math.max(0, ey - by) };
    }

    function maskOf(polys, bb, blur, dx, dy) {
      const c = document.createElement('canvas');
      c.width = bb.bw;
      c.height = bb.bh;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (blur > 0) g.filter = `blur(${blur}px)`;
      g.fillStyle = '#fff';
      g.beginPath();
      for (const poly of polys) {
        poly.forEach(([x, y], i) => {
          const px = x * S - bb.bx + (dx || 0), py = y * S - bb.by + (dy || 0);
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        });
        g.closePath();
      }
      g.fill();
      const data = g.getImageData(0, 0, bb.bw, bb.bh).data;
      const a = new Float32Array(bb.bw * bb.bh);
      for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255;
      return a;
    }

    function paint(d, o, kind) {
      const t = tex();
      const gouache = kind === 'gouache';
      o = Object.assign(
        gouache
          ? { alpha: 0.98, edge: 0.22, gran: 0.05, var: 0.1, streak: 0.07, soft: 1.1, pool: 4, softMix: 0.12, wob: 1.4, mode: 'over' }
          : { alpha: 0.85, edge: 0.6, gran: 0.1, var: 0.16, streak: 0.04, soft: 2.6, pool: 8, softMix: 0.55, wob: 3.2, mode: 'multiply' },
        o || {}
      );
      const polys = polysFor(d, { wob: o.wob, wf: o.wf, step: o.step });
      const pad = Math.ceil(Math.max(o.soft, o.pool) * 2.2 * S) + 6;
      const bb = bboxOf(polys, pad);
      if (bb.bw < 2 || bb.bh < 2) return;
      const mc = maskOf(polys, bb, 0.5);
      const ms = maskOf(polys, bb, o.soft * S);
      const mp = maskOf(polys, bb, o.pool * S);
      const c1 = hex(o.c1 || '#888888'), c2 = hex(o.c2 || o.c1 || '#888888'), c3 = o.c3 ? hex(o.c3) : null;
      const stops = o.vgrad ? o.vgrad.map(([tt, c]) => [tt, hex(c)]) : null;
      const gy0 = (o.gradY ? o.gradY[0] : bb.by / S), gy1 = (o.gradY ? o.gradY[1] : (bb.by + bb.bh) / S);
      const out = new ImageData(bb.bw, bb.bh);
      const od = out.data;
      const streakTex = o.vstreak ? t.sv : t.st;
      for (let y = 0; y < bb.bh; y++) {
        const gyp = bb.by + y;
        for (let x = 0; x < bb.bw; x++) {
          const i = y * bb.bw + x;
          const cr = mc[i], so = ms[i];
          if (cr < 0.004 && so < 0.004) continue;
          const gi = gyp * W + bb.bx + x;
          const sm = clamp(o.softMix + (t.b2[gi] - 0.5) * 1.5, 0, 1);
          const m = cr + (so - cr) * sm;
          if (m < 0.004) continue;
          const e = clamp((m - mp[i]) * 3, 0, 1) * o.edge;
          const n1 = t.b1[gi], n2 = t.b2[gi];
          let col;
          if (stops) {
            const tt = clamp((gyp / S - gy0) / (gy1 - gy0), 0, 1);
            let k = 0;
            while (k < stops.length - 2 && tt > stops[k + 1][0]) k++;
            const s0 = stops[k], s1 = stops[k + 1];
            col = mix3(s0[1], s1[1], clamp((tt - s0[0]) / (s1[0] - s0[0] || 1), 0, 1));
            col = mix3(col, c2, smooth(0.35, 0.75, n1) * 0.35);
          } else {
            col = mix3(c1, c2, smooth(0.3, 0.7, n1));
          }
          if (c3) col = mix3(col, c3, smooth(0.55, 0.8, n2) * 0.65);
          let k2 = 1 + (n1 - 0.5) * o.var + (streakTex[gi] - 0.5) * o.streak;
          k2 *= 1 - e * 0.4;
          k2 *= 1 + (t.gr[gi] - 0.5) * o.gran;
          let a = m * o.alpha;
          if (o.dry) a *= 1 - o.dry * (1 - smooth(0.15, 0.85, m)) * (t.hf[gi] > m * 1.25 ? 1 : 0);
          const j = i * 4;
          od[j] = clamp(col[0] * k2 * (1 - e * 0.1), 0, 255);
          od[j + 1] = clamp(col[1] * k2 * (1 - e * 0.04), 0, 255);
          od[j + 2] = clamp(col[2] * k2, 0, 255);
          od[j + 3] = clamp(a * 255, 0, 255);
        }
      }
      const tmp = document.createElement('canvas');
      tmp.width = bb.bw;
      tmp.height = bb.bh;
      tmp.getContext('2d').putImageData(out, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = o.mode === 'multiply' ? 'multiply' : 'source-over';
      ctx.drawImage(tmp, bb.bx, bb.by);
      ctx.restore();
    }

    /** Plain filled path with a little wobble: for small details (fence posts, windows, roofs). */
    function fillPath(d, color, o) {
      o = o || {};
      const polys = polysFor(d, { wob: o.wob == null ? 0.5 : o.wob, wf: 0.08, step: 2 });
      ctx.save();
      ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const poly of polys) {
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
    }

    function strokePath(d, color, width, o) {
      o = o || {};
      const polys = polysFor(d, { wob: o.wob == null ? 0.4 : o.wob, wf: 0.08, step: 2 });
      ctx.save();
      ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * S;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const poly of polys) {
        ctx.beginPath();
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
        ctx.stroke();
      }
      ctx.restore();
    }

    /** Faint graphite under-drawing: broken, doubled, slightly wandering lines. */
    function pencil(d, o) {
      o = o || {};
      const rr = mulberry((o.seed || 5) * 71 + 3);
      for (let pass = 0; pass < 2; pass++) {
        const polys = polysFor(d, { wob: 0.9 + pass * 0.8, wf: 0.05, step: 3 });
        ctx.save();
        ctx.strokeStyle = '#6f695d';
        ctx.lineCap = 'round';
        ctx.lineWidth = (0.55 + pass * 0.15) * S;
        ctx.globalAlpha = (o.alpha || 0.5) * (pass ? 0.7 : 1);
        for (const poly of polys) {
          let drawing = false;
          ctx.beginPath();
          poly.forEach(([x, y], i) => {
            const on = N(x * 0.06 + pass * 9, y * 0.06) > -0.12 && rr() > 0.04;
            if (on) {
              if (!drawing) { ctx.moveTo(x * S, y * S); drawing = true; } else ctx.lineTo(x * S, y * S);
            } else drawing = false;
          });
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    function sunGlow(cx, cy, rx, ry, color, alpha, mode) {
      ctx.save();
      ctx.globalCompositeOperation = mode || 'source-over';
      const g = ctx.createRadialGradient(cx * S, cy * S, 0, cx * S, cy * S, rx * S);
      g.addColorStop(0, rgb(hex(color), alpha));
      g.addColorStop(1, rgb(hex(color), 0));
      ctx.translate(0, cy * S);
      ctx.scale(1, ry / rx);
      ctx.translate(0, -cy * S);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H * 3);
      ctx.restore();
    }

    /**
     * A foliage mass painted as dabbed leaf strokes. Lit side faces the sun (upper left), the underside turns cool and dark.
     * pal: {s: shadow, m: mid, l: light, r: rim, u: cool undersides}
     */
    function crown(cx, cy, rx, ry, pal, o) {
      o = o || {};
      const rr = mulberry((o.seed || 1) * 977 + Math.round(cx * 7 + cy * 13));
      const cs = hex(pal.s), cm = hex(pal.m), cl = hex(pal.l), cr = hex(pal.r), cu = hex(pal.u || pal.s);
      const ph1 = rr() * 6.28, ph2 = rr() * 6.28;
      const radial = (a) => 1 + 0.2 * Math.sin(3 * a + ph1) + 0.1 * Math.sin(5 * a + ph2) + 0.08 * Math.sin(8 * a + ph1);
      const small = rx < 42;
      o.small = small;
      const count = Math.max(40, Math.floor(rx * ry * 0.075 * (o.density || 1) * (small ? 4 : 1)));
      const size = (rx + ry) * 0.5 * (o.leaf || 0.17) * (small ? 0.62 : 1);
      const leaves = [];
      for (let k = 0; k < count; k++) {
        const a = rr() * Math.PI * 2;
        const d = Math.pow(rr(), 0.7) * 0.92;
        const f = radial(a) * 0.9;
        const nx = Math.cos(a) * d * f, ny = Math.sin(a) * d * f * 0.95;
        const x = cx + nx * rx, y = cy + ny * ry;
        let l = (small ? 0.68 : 0.6) - (nx * 0.5 + ny * 0.72) * 0.55 + (rr() - 0.5) * 0.32 + (N(x * 0.1, y * 0.1) - 0.0) * 0.18;
        if (ny > 0.45) l -= (ny - 0.45) * 0.9;
        leaves.push({ x, y, l: clamp(l, 0, 1), ang: Math.atan2(ny, nx) + (rr() - 0.5) * 1.6, sz: size * (0.7 + rr() * 0.8), ny, nx });
      }
      // base silhouette (so the mass has no holes) in the cool shadow tone
      ctx.save();
      ctx.fillStyle = rgb(o.small ? mix3(cs, cm, 0.45) : mix3(cu, cs, 0.45), 1);
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const f = radial(a) * 0.82;
        const x = (cx + Math.cos(a) * rx * f) * S, y = (cy + Math.sin(a) * ry * f * 0.95) * S;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.fill();
      ctx.restore();
      leaves.sort((p, q) => p.l - q.l);
      for (const lf of leaves) {
        let c;
        if (lf.l < 0.18) c = mix3(cu, cs, lf.l / 0.18);
        else if (lf.l < 0.5) c = mix3(cs, cm, (lf.l - 0.18) / 0.32);
        else if (lf.l < 0.82) c = mix3(cm, cl, (lf.l - 0.5) / 0.32);
        else c = mix3(cl, cr, clamp((lf.l - 0.82) / 0.18, 0, 1) * 0.85);
        const jit = 1 + (rr() - 0.5) * 0.14;
        c = [c[0] * jit, c[1] * (1 + (rr() - 0.5) * 0.08), c[2] * jit];
        ctx.save();
        ctx.translate(lf.x * S, lf.y * S);
        ctx.rotate(lf.ang);
        const w = lf.sz * S * 1.5, h = lf.sz * S * 0.62;
        ctx.fillStyle = rgb(c, 0.94);
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0);
        ctx.quadraticCurveTo(-w * 0.1, -h, w / 2, (rr() - 0.5) * h * 0.5);
        ctx.quadraticCurveTo(-w * 0.05, h * 0.9, -w / 2, 0);
        ctx.fill();
        ctx.restore();
      }
      // a few stray twigs/leaf flecks past the edge keep the silhouette irregular
      for (let k = 0; k < count * 0.07; k++) {
        const a = rr() * Math.PI * 2;
        const f = radial(a) * (0.95 + rr() * 0.12);
        const x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f * 0.95;
        const lit = clamp(0.5 - (Math.cos(a) * 0.5 + Math.sin(a) * 0.72) * 0.5, 0, 1);
        ctx.fillStyle = rgb(mix3(cs, cl, lit), 0.9);
        ctx.beginPath();
        ctx.ellipse(x * S, y * S, size * S * 0.5, size * S * 0.26, a + 1.2, 0, 6.28);
        ctx.fill();
      }
    }

    /** Scatter small dabs (wildflowers, dapple light, seed heads). */
    function dabs(color, count, x0, x1, y0, y1, size, o) {
      o = o || {};
      const rr = mulberry((o.seed || 3) * 53 + count);
      ctx.save();
      ctx.fillStyle = color;
      for (let k = 0; k < count; k++) {
        const x = lerp(x0, x1, rr()), y = lerp(y0, y1, rr());
        ctx.globalAlpha = (o.alpha || 0.95) * (0.7 + rr() * 0.3);
        ctx.beginPath();
        ctx.ellipse(x * S, y * S, size * S * (0.6 + rr() * 0.7), size * S * (0.45 + rr() * 0.4) * 0.8, rr() * 3, 0, 6.28);
        ctx.fill();
      }
      ctx.restore();
    }

    /** Blades of grass with dark bases and sun-lit tips. */
    function blades(x0, x1, yBase, hMin, hMax, count, cols, o) {
      o = o || {};
      const rr = mulberry((o.seed || 2) * 199 + count);
      const dark = hex(cols[0]), mid = hex(cols[1]), light = hex(cols[2]);
      for (let k = 0; k < count; k++) {
        const x = lerp(x0, x1, (k + rr() * 0.9) / count);
        const h = hMin + Math.pow(rr(), 1.6) * (hMax - hMin);
        const lean = (rr() - 0.4) * 0.5 * h;
        const w = 1.3 + rr() * 1.5;
        const g = ctx.createLinearGradient(x * S, yBase * S, (x + lean) * S, (yBase - h) * S);
        g.addColorStop(0, rgb(dark, 1));
        g.addColorStop(0.55, rgb(mid, 1));
        g.addColorStop(1, rgb(light, 1));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo((x - w / 2) * S, yBase * S);
        ctx.quadraticCurveTo((x + lean * 0.3 - w * 0.3) * S, (yBase - h * 0.6) * S, (x + lean) * S, (yBase - h) * S);
        ctx.quadraticCurveTo((x + lean * 0.5 + w * 0.6) * S, (yBase - h * 0.5) * S, (x + w / 2) * S, yBase * S);
        ctx.fill();
      }
    }

    /**
     * Cumulus painted mostly as bare paper: feathered billowy edge with a few crisp dry-brush stretches,
     * cool lilac-grey shading on the lower right and underside, light granulation, partial pencil outline.
     */
    function cumulus(puffs, o) {
      const t = tex();
      o = Object.assign({ shade: 1, soft: 3.2, body: '#fffaf0', body2: '#f4ecd8', shadeCol: '#b4b6d0', shadeCol2: '#9ea6c4', dx: 10, dy: 12, pencil: 0, alpha: 1 }, o || {});
      const polys = puffs.map(([x, y, r]) => {
        const pts = [];
        const n = 54;
        const ph = N(x * 0.13, y * 0.13) * 6;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const rad = r * (1 + 0.15 * Math.sin(5 * a + ph) + 0.08 * Math.sin(9 * a + ph * 2) + (N(Math.cos(a) * 1.8 + x * 0.07, Math.sin(a) * 1.8 + y * 0.07) * 0.1));
          pts.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad * 0.9]);
        }
        return pts;
      });
      const bb = bboxOf(polys, Math.ceil(o.soft * S * 2.4) + Math.ceil(o.dx * S) + 8);
      const mc = maskOf(polys, bb, 0.6);
      const ms = maskOf(polys, bb, o.soft * S);
      const sh = maskOf(polys, bb, o.soft * S * 1.4, -o.dx * S, -o.dy * S);
      const out = new ImageData(bb.bw, bb.bh);
      const od = out.data;
      const body = hex(o.body), body2 = hex(o.body2), sc = hex(o.shadeCol), sc2 = hex(o.shadeCol2);
      let minY = 1e9, maxY = -1e9;
      polys.forEach((p) => p.forEach(([, y]) => { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }));
      for (let y = 0; y < bb.bh; y++) {
        const gyp = bb.by + y;
        const vy = clamp((gyp / S - minY) / (maxY - minY), 0, 1);
        for (let x = 0; x < bb.bw; x++) {
          const i = y * bb.bw + x;
          const gi = gyp * W + bb.bx + x;
          const sm = clamp(0.55 + (t.b2[gi] - 0.5) * 1.8, 0, 1);
          const m = mc[i] + (ms[i] - mc[i]) * sm;
          if (m < 0.004) continue;
          const crescent = clamp(ms[i] * (1 - sh[i]) * 1.5, 0, 1);
          const under = smooth(0.5, 1, vy) * 0.55;
          let s = clamp(crescent * 0.85 + under * ms[i], 0, 1) * o.shade;
          s *= 0.78 + (t.gr[gi] - 0.5) * 0.5 + (t.b1[gi] - 0.5) * 0.5;
          s = clamp(s, 0, 1);
          let col = mix3(body, body2, smooth(0.3, 0.8, t.b1[gi]));
          col = mix3(col, mix3(sc, sc2, t.b2[gi]), s * 0.8);
          const j = i * 4;
          od[j] = col[0]; od[j + 1] = col[1]; od[j + 2] = col[2];
          od[j + 3] = clamp(m * o.alpha * 255, 0, 255);
        }
      }
      const tmp = document.createElement('canvas');
      tmp.width = bb.bw;
      tmp.height = bb.bh;
      tmp.getContext('2d').putImageData(out, 0, 0);
      ctx.drawImage(tmp, bb.bx, bb.by);
      if (o.pencil) {
        ctx.save();
        ctx.strokeStyle = '#6f695d';
        ctx.globalAlpha = o.pencil;
        ctx.lineWidth = 0.6 * S;
        for (const poly of polys) {
          let drawing = false;
          ctx.beginPath();
          poly.forEach(([x, y], i) => {
            const on = N(x * 0.05 + 3, y * 0.05) > -0.05 && (y > minY + (maxY - minY) * 0.55);
            if (on) { if (!drawing) { ctx.moveTo(x * S + 1, y * S + 1); drawing = true; } else ctx.lineTo(x * S + 1, y * S + 1); } else drawing = false;
          });
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /** Multiply the whole canvas by the soft, deckled alpha of a painted vignette, with pigment pooled at its edge. */
    function vignette(d, o) {
      const t = tex();
      o = Object.assign({ wob: 11, wf: 0.022, soft: 2.2, pool: 9, dry: 0.7, edge: 0.14 }, o || {});
      const polys = polysFor(d, { wob: o.wob, wf: o.wf, step: 4 });
      const bb = { bx: 0, by: 0, bw: W, bh: H };
      const mc = maskOf(polys, bb, 0.5);
      const ms = maskOf(polys, bb, o.soft * S);
      const mp = maskOf(polys, bb, o.pool * S);
      const id = ctx.getImageData(0, 0, W, H);
      const dd = id.data;
      for (let i = 0; i < W * H; i++) {
        const sm = clamp(0.4 + (t.b2[i] - 0.5) * 1.6, 0, 1);
        let m = mc[i] + (ms[i] - mc[i]) * sm;
        const e = clamp((m - mp[i]) * 3, 0, 1) * o.edge;
        m *= 1 - o.dry * (1 - smooth(0.2, 0.9, m)) * (t.hf[i] > m * 1.3 ? 1 : 0);
        const j = i * 4;
        dd[j] *= 1 - e; dd[j + 1] *= 1 - e * 0.8; dd[j + 2] *= 1 - e * 0.6;
        dd[j + 3] = clamp(dd[j + 3] * m, 0, 255);
      }
      ctx.putImageData(id, 0, 0);
    }

    /** Light paper grain and a tiny warp so no edge is perfectly clean. */
    function finish(o) {
      const t = tex();
      o = Object.assign({ grain: 0.035, warp: 1.1 }, o || {});
      let id = ctx.getImageData(0, 0, W, H);
      if (o.warp > 0) {
        const src = new Uint8ClampedArray(id.data);
        const dd = id.data;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const sx = clamp(Math.round(x + (t.b2[i] - 0.5) * 2 * o.warp), 0, W - 1);
          const sy = clamp(Math.round(y + (t.b1[i] - 0.5) * 2 * o.warp), 0, H - 1);
          const k = (sy * W + sx) * 4, j = i * 4;
          dd[j] = src[k]; dd[j + 1] = src[k + 1]; dd[j + 2] = src[k + 2]; dd[j + 3] = src[k + 3];
        }
      }
      const dd = id.data;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        if (dd[j + 3] === 0) continue;
        const g = 1 + (t.gr[i] - 0.5) * o.grain * 2;
        dd[j] *= g; dd[j + 1] *= g; dd[j + 2] *= g;
      }
      ctx.putImageData(id, 0, 0);
    }

    /** Crop to the non-transparent bounds; returns the cropped canvas and its rect in frame fractions. */
    function trim(pad) {
      const id = ctx.getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (id[(y * W + x) * 4 + 3] > 6) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < x0) return null;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
      const c = document.createElement('canvas');
      c.width = x1 - x0 + 1;
      c.height = y1 - y0 + 1;
      c.getContext('2d').drawImage(canvas, -x0, -y0);
      return { canvas: c, rect: { left: x0 / W, top: y0 / H, width: c.width / W, height: c.height / H } };
    }

    function fill(color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, W, H);
    }

    return {
      canvas, ctx, W, H, S, noise: N, rand: R,
      wash: (d, o) => paint(d, o, 'wash'),
      gouache: (d, o) => paint(d, o, 'gouache'),
      fillPath, strokePath, pencil, sunGlow, crown, dabs, blades, cumulus, vignette, finish, trim, fill,
    };
  }

  window.Painter = Painter;
  window.PaintUtil = { hex, mix3, rgb, mulberry };
})();
