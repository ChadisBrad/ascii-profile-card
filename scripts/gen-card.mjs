#!/usr/bin/env node
// Builds assets/card.svg: a letter drawn as lit, outlined 3D ASCII art, swaying slowly, beside
// your name, a tagline and a few facts from profile.config.json.
//
// The animation is plain CSS inside the SVG (one group per frame, switched on and off), so it
// plays in a GitHub README with no JavaScript. There is no live data in it, so nothing goes stale
// and nothing needs a scheduled job.
//
// The character-art method is after JIN2 (@jin_22ee). scripts/ascii3d.mjs is an independent
// implementation of that method; none of his code is in this repo.
//
// Usage:
//   node scripts/gen-card.mjs                    writes assets/card.svg
//   node scripts/gen-card.mjs --config <file>    reads another config
//   node scripts/gen-card.mjs --out <file>       writes somewhere else
//   node scripts/gen-card.mjs --frame <k>        a still of frame k only

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAU, clamp, seeded, cloud, concat, rotateY, camera, project, shade,
  grid, clearGrid, rasterize, outlinesAndFill, particles, CHARS,
} from './ascii3d.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- layout ----------

export const W = 920;
export const H = 400;
export const ART = { x: 26, y: 24, cols: 44, rows: 27, cellW: 7.4, cellH: 13.2 };
export const FRAMES = 48;
export const SECONDS = 10;
const LEVELS = 6;

const C = {
  bg: '#0b0b0c',
  edge: '#232326',
  text: '#ececec',
  soft: '#9b9b9f',
  dim: '#5c5c61',
  gold: '#c9a54a',
};
const SANS = `'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;

// colour per kind: 0 face (silver), 1 walls (steel), 2 glint (white), 3 dust (gold)
const PALETTE = [[228, 231, 237], [128, 134, 146], [255, 255, 255], [214, 176, 84]];

/** The default shape: a squared-off S, as one stroke through these points. */
export const S_SPINE = [[0.66, 1], [-0.62, 1], [-0.62, 0], [0.62, 0], [0.62, -1], [-0.66, -1]];

// ---------- config ----------

/** Reads and checks the card config. Throws naming the field that is wrong. */
export function readConfig(file = path.join(ROOT, 'profile.config.json')) {
  return checkConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function checkConfig(cfg) {
  const where = 'profile.config.json';
  for (const key of ['name', 'tagline']) {
    if (typeof cfg[key] !== 'string' || !cfg[key].trim()) throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  if (cfg.name.length > 28) throw new Error(`${where}: "name" is ${cfg.name.length} characters; the card fits 28`);
  if (cfg.tagline.length > 52) throw new Error(`${where}: "tagline" is ${cfg.tagline.length} characters; the card fits 52`);
  if (!Array.isArray(cfg.facts) || cfg.facts.length === 0) throw new Error(`${where}: "facts" must be a non-empty list of [label, value] pairs`);
  if (cfg.facts.length > 8) throw new Error(`${where}: "facts" has ${cfg.facts.length} rows; the card fits 8`);
  cfg.facts.forEach((f, i) => {
    if (!Array.isArray(f) || f.length !== 2 || f.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${where}: facts[${i}] must be ["label", "value"]`);
    }
    if (f[0].length > 9) throw new Error(`${where}: facts[${i}] label "${f[0]}" is longer than 9 characters`);
    if (f[1].length > 52) throw new Error(`${where}: facts[${i}] value is ${f[1].length} characters; the card fits 52`);
  });
  if (cfg.shape !== undefined) {
    const { spine, thickness } = cfg.shape;
    if (spine !== undefined) {
      const ok = Array.isArray(spine) && spine.length >= 2 && spine.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && v >= -1 && v <= 1));
      if (!ok) throw new Error(`${where}: "shape.spine" must be 2 or more [x, y] points, each between -1 and 1`);
    }
    if (thickness !== undefined && !(typeof thickness === 'number' && thickness >= 0.12 && thickness <= 0.35)) {
      throw new Error(`${where}: "shape.thickness" must be a number from 0.12 to 0.35`);
    }
  }
  return cfg;
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- the shape, as a 3D point cloud ----------

/** A polyline through `pts` with each inside corner rounded (quadratic curve of radius r). */
export function roundedPath(pts, r, steps = 12) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const unit = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
    const d1 = unit(a, b), d2 = unit(b, c);
    // never round past the middle of either segment
    const rr = Math.min(r, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
    const p1 = [b[0] - d1[0] * rr, b[1] - d1[1] * rr], p2 = [b[0] + d2[0] * rr, b[1] + d2[1] * rr];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      out.push([u * u * p1[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * b[1] + t * t * p2[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Distance from (x, y) to a polyline. */
function distTo(path2, x, y) {
  let best = Infinity;
  for (let i = 0; i < path2.length - 1; i++) {
    const [ax, ay] = path2[i], [bx, by] = path2[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2);
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * A thick stroke along `spine`, extruded into a solid. Front face with a bevel (normals tilt
 * outward near the edge, so edges catch light) and side walls whose normals follow the outline.
 * The back is never seen, so it is skipped.
 */
export function buildShape({ spine = S_SPINE, thickness = 0.25, corner = 0.46, step = 0.01, bevel = 0.08, depth = 0.42, wallSteps = 18 } = {}) {
  const half = thickness;
  const line = roundedPath(spine, corner);
  const pad = half + 0.06;
  const x0 = Math.min(...spine.map((p) => p[0])) - pad, x1 = Math.max(...spine.map((p) => p[0])) + pad;
  const y0 = Math.min(...spine.map((p) => p[1])) - pad, y1 = Math.max(...spine.map((p) => p[1])) + pad;
  const xs = Math.ceil((x1 - x0) / step), ys = Math.ceil((y1 - y0) / step);
  const s = new Float32Array(xs * ys);
  const X = (i) => x0 + i * step, Y = (j) => y1 - j * step;
  for (let j = 0; j < ys; j++) for (let i = 0; i < xs; i++) s[j * xs + i] = distTo(line, X(i), Y(j));
  const at = (i, j) => s[clamp(j, 0, ys - 1) * xs + clamp(i, 0, xs - 1)];
  const front = [], walls = [];
  for (let j = 0; j < ys; j++) {
    for (let i = 0; i < xs; i++) {
      const d = s[j * xs + i];
      if (d > half) continue;
      // outward direction in the plane: the gradient of the distance field
      let gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), gy = (at(i, j - 1) - at(i, j + 1)) / (2 * step);
      const gl = Math.hypot(gx, gy) || 1;
      gx /= gl; gy /= gl;
      const e = clamp((d - (half - bevel)) / bevel);
      front.push([X(i), Y(j), depth / 2, gx * e * 0.85, gy * e * 0.85, 1 - 0.45 * e]);
      const edge = at(i + 1, j) > half || at(i - 1, j) > half || at(i, j + 1) > half || at(i, j - 1) > half;
      if (edge) for (let k = 0; k <= wallSteps; k++) walls.push([X(i), Y(j), depth / 2 - (k / wallSteps) * depth, gx, gy, 0]);
    }
  }
  const toCloud = (list, part, kind) => {
    const c = cloud(list.length);
    list.forEach((q, k) => {
      const l = Math.hypot(q[3], q[4], q[5]) || 1;
      c.p.set([q[0], q[1], q[2]], k * 3);
      c.nrm.set([q[3] / l, q[4] / l, q[5] / l], k * 3);
      c.part[k] = part;
      c.kind[k] = kind;
    });
    return c;
  };
  return concat([toCloud(front, 0, 0), toCloud(walls, 1, 1)]);
}

// ---------- frames ----------

/** Renders every frame to a character grid: [{ char, lum, kind }] per frame. */
export function renderFrames(frames = FRAMES, { shape = {}, art = ART, focal = 3.95, moteCount = 14, glints = 2, seconds = SECONDS } = {}) {
  const { cols, rows, cellW, cellH } = art;
  const aspect = (cols * cellW) / (rows * cellH);
  const base = buildShape(shape);
  const turned = cloud(base.n);
  const cam = camera([0, 0.55, 5.4], [0, -0.02, 0], focal);
  const key = (() => { const v = [-0.55, 0.62, 0.6], l = Math.hypot(...v); return v.map((x) => x / l); })();
  const lum = new Float32Array(base.n);
  const g = grid(cols, rows);

  // gold dust on slow orbits; whole turns per loop so the animation wraps cleanly
  const rnd = seeded(7);
  const motes = Array.from({ length: moteCount }, () => ({ r: 1.1 + rnd() * 0.35, y: -1.1 + rnd() * 2.2, a: rnd() * TAU, turns: rnd() < 0.5 ? 1 : -1, ph: rnd() * TAU }));
  const dust = cloud(motes.length);
  const dustGlow = new Float32Array(motes.length);
  const dustKinds = new Uint8Array(motes.length).fill(3);

  const out = [];
  for (let f = 0; f < frames; f++) {
    const t = f / frames; // 0..1 around the loop
    rotateY(base, 0.36 * Math.sin(TAU * t), turned);
    const ra = TAU * t + 1.2;
    const rim = [Math.cos(ra) * 0.85, 0.35, -0.25 + Math.sin(ra) * 0.45];
    const rl = Math.hypot(...rim);
    shade(turned, { key, rim: rim.map((x) => x / rl), view: cam.view, ambient: 0.42, diffuse: 0.72, specular: 0.55, keyPower: 30, rimPower: 22, rimAmount: 0.9 }, lum);
    const proj = project(turned, cam, cols, rows, aspect);
    clearGrid(g);
    rasterize(g, turned, proj, lum);

    // glints: the few brightest cells, spaced apart, become stars
    const cand = [];
    for (let i = 0; i < g.lum.length; i++) if (g.part[i] >= 0 && g.lum[i] > 1.12) cand.push(i);
    cand.sort((a, b) => g.lum[b] - g.lum[a]);
    const picked = [];
    for (const i of cand) {
      const x = i % cols, y = (i / cols) | 0;
      if (picked.some((j) => Math.hypot((x - (j % cols)) / 2, y - ((j / cols) | 0)) < 5)) continue;
      picked.push(i);
      if (picked.length >= glints) break;
    }
    for (const i of picked) { g.glint[i] = 1; g.kind[i] = 2; }
    outlinesAndFill(g, t * seconds, { gap: 0.03, shimmer: 0.8 });

    motes.forEach((m, k) => {
      const a = m.a + m.turns * TAU * t;
      dust.p.set([Math.cos(a) * m.r, m.y + 0.06 * Math.sin(TAU * t + m.ph), Math.sin(a) * m.r * 0.6], k * 3);
      dustGlow[k] = 0.12 + 0.42 * (0.5 + 0.5 * Math.sin(TAU * 2 * t + m.ph));
    });
    particles(g, project(dust, cam, cols, rows, aspect), dustGlow, dustKinds);

    out.push({ char: Uint8Array.from(g.char), lum: Float32Array.from(g.lum), kind: Uint8Array.from(g.kind) });
  }
  return out;
}

// ---------- SVG ----------

const level = (lum) => clamp(Math.round(clamp(lum) * LEVELS) - 1, 0, LEVELS - 1);
const cls = (kind, lv) => `k${kind}${lv}`;

/** One frame as rows of <text>, runs of the same colour sharing a <tspan>. */
export function frameSvg(fr, art = ART) {
  const { cols, rows, cellW, cellH } = art;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let end = cols;
    while (end > 0 && fr.char[y * cols + end - 1] === 0) end--;
    if (end === 0) continue;
    let start = 0;
    while (fr.char[y * cols + start] === 0) start++;
    let body = '', run = '', runCls = null;
    const flush = () => { if (run) body += runCls ? `<tspan class="${runCls}">${esc(run)}</tspan>` : run; run = ''; };
    for (let x = start; x < end; x++) {
      const i = y * cols + x, c = fr.char[i];
      const k = c === 0 ? null : cls(fr.kind[i], level(fr.lum[i]));
      if (k !== runCls) { flush(); runCls = k; }
      run += c === 0 ? ' ' : CHARS[c];
    }
    flush();
    const tx = (start * cellW).toFixed(1), ty = (y * cellH + cellH * 0.78).toFixed(1);
    lines.push(`<text x="${tx}" y="${ty}" textLength="${((end - start) * cellW).toFixed(1)}" lengthAdjust="spacing">${body}</text>`);
  }
  return lines.join('');
}

export function colourCss() {
  const out = [];
  PALETTE.forEach((rgb, k) => {
    for (let l = 0; l < LEVELS; l++) {
      const f = 0.32 + 0.68 * ((l + 1) / LEVELS);
      out.push(`.${cls(k, l)}{fill:rgb(${rgb.map((v) => Math.round(v * f)).join(',')})}`);
    }
  });
  return out.join('');
}

/** The whole card. `still` renders one frame without animation. */
export function buildCard(cfg, { frames = FRAMES, still = null } = {}) {
  const all = renderFrames(frames, { shape: cfg.shape ?? {} });
  const shown = still === null ? all : [all[still % frames]];
  const step = SECONDS / frames;
  const anim = still === null
    ? `.f{opacity:0;animation:show ${SECONDS}s linear infinite}` +
      `@keyframes show{0%{opacity:1}${(100 / frames).toFixed(3)}%{opacity:1}${(100 / frames + 0.001).toFixed(3)}%{opacity:0}100%{opacity:0}}` +
      shown.map((_, k) => `.f${k}{animation-delay:${(k * step - SECONDS).toFixed(3)}s}`).join('') +
      `@media (prefers-reduced-motion:reduce){.f{animation:none}.f0{opacity:1}}`
    : '.f{opacity:1}';

  const tx = 404;
  const facts = cfg.facts.map(([label, value], i) => {
    const y = 176 + i * 27;
    return `<text class="m" x="${tx}" y="${y}"><tspan class="lab">${esc(label)}</tspan><tspan x="${tx + 82}">${esc(value)}</tspan></text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${cfg.name}. ${cfg.tagline} ${cfg.facts.map(([l, v]) => `${l}: ${v}`).join('. ')}.`)}">
<style>
.art text{font-family:${MONO};font-size:11.4px;font-weight:600;white-space:pre}
.name{font-family:${SANS};font-size:31px;font-weight:600;fill:${C.text};letter-spacing:-.3px}
.tag{font-family:${SANS};font-size:15px;fill:${C.soft}}
.m{font-family:${MONO};font-size:13px;fill:${C.text}}
.lab{fill:${C.gold}}
.cred{font-family:${MONO};font-size:10px;fill:${C.dim}}
${colourCss()}
${anim}
</style>
<defs><filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${C.bg}" stroke="${C.edge}"/>
<g class="art" transform="translate(${ART.x},${ART.y})" filter="url(#glow)" xml:space="preserve">
${shown.map((fr, k) => `<g class="f f${k}">${frameSvg(fr)}</g>`).join('\n')}
</g>
<line x1="378" y1="44" x2="378" y2="${H - 44}" stroke="${C.edge}"/>
<text class="name" x="${tx}" y="84">${esc(cfg.name)}</text>
<text class="tag" x="${tx}" y="112">${esc(cfg.tagline)}</text>
<line x1="${tx}" y1="134" x2="${tx + 44}" y2="134" stroke="${C.gold}" stroke-width="2"/>
${facts}
<text class="cred" x="${W - 24}" y="${H - 18}" text-anchor="end">art after JIN2 (@jin_22ee)</text>
</svg>
`;
}

// ---------- CLI ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const out = arg('--out') ?? path.join(ROOT, 'assets', 'card.svg');
  const still = arg('--frame');
  const cfg = readConfig(arg('--config') ?? undefined);
  const svg = buildCard(cfg,{ still: still === null ? null : Number(still) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, svg);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB)`);
}
