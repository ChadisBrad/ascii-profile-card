/**
 * ascii3d.mjs: lit, outlined 3D objects drawn only with characters.
 * gen-card.mjs uses the grid stages to write an SVG; createRenderer draws to a canvas in a browser.
 *
 * The method is learned from JIN2 (@jin_22ee, github.com/JIN2-ASCII), whose
 * rose and diamond ring showed it: build the object as a cloud of 3D points
 * that know their surface normal, light it, project it, keep the nearest
 * point per character cell, draw outlines as | / \ - _ following the edge and
 * fill the inside with letters chosen by brightness, then glyphs, colour,
 * trails and glow. This file is an independent implementation written from
 * that description; none of JIN2's code is in it. Credit him for the style.
 *
 * Plain ES module with JSDoc types: runs in a browser as is, and pastes into
 * a TypeScript project with light annotation. No dependencies.
 *
 * Pipeline per frame:
 *   points (cloud) -> transform -> shade() -> project() -> rasterize()
 *   -> outlines() + fill -> glints/rays, particles -> renderer.draw()
 */

// ---------------------------------------------------------------- helpers

export const TAU = Math.PI * 2;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smooth = (x) => {
    const t = clamp(x);
    return t * t * (3 - 2 * t);
};
const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A small seeded random source (mulberry32): the same piece every run. */
export function seeded(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------- point clouds

/**
 * @typedef {object} Cloud
 * @property {number} n
 * @property {Float32Array} p      xyz per point
 * @property {Float32Array} nrm    unit normal per point
 * @property {Int32Array} part     which part (outlines are drawn between parts and against empty space)
 * @property {Uint8Array} kind     colour slot in the palette
 * @property {Float32Array} order  when it is drawn in (0..max), for the travelling-light reveal
 */

/** @returns {Cloud} */
export function cloud(n) {
    return { n, p: new Float32Array(n * 3), nrm: new Float32Array(n * 3), part: new Int32Array(n), kind: new Uint8Array(n), order: new Float32Array(n) };
}

/** @param {Cloud[]} list @returns {Cloud} */
export function concat(list) {
    const out = cloud(list.reduce((s, c) => s + c.n, 0));
    let k = 0;
    for (const c of list) {
        out.p.set(c.p, k * 3);
        out.nrm.set(c.nrm, k * 3);
        out.part.set(c.part, k);
        out.kind.set(c.kind, k);
        out.order.set(c.order, k);
        k += c.n;
    }
    return out;
}

/**
 * A parametric surface sampled on an nu x nv grid. `at(u, v)` returns [x, y, z]
 * for u, v in 0..1. Normals come from the grid itself: the cross product of
 * the two directions along it (central differences), so any shape you can
 * write as a formula can be lit. `outward(x, y, z)` (optional) is a direction
 * the normal should face; it flips any that face the other way.
 * `order(u, v)` gives the reveal order; `part` and `kind` label every point.
 *
 * @returns {Cloud}
 */
export function surface(nu, nv, at, { part = 0, kind = 0, order = () => 0, outward = null } = {}) {
    const c = cloud(nu * nv);
    const P = new Float32Array(nu * nv * 3);
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
            const q = at(nu === 1 ? 0 : i / (nu - 1), nv === 1 ? 0 : j / (nv - 1));
            P.set(q, (j * nu + i) * 3);
        }
    }
    const get = (i, j) => (Math.min(nv - 1, Math.max(0, j)) * nu + Math.min(nu - 1, Math.max(0, i))) * 3;
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
            const k = j * nu + i, a = get(i + 1, j), b = get(i - 1, j), cc = get(i, j + 1), d = get(i, j - 1);
            const du = [P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]];
            const dv = [P[cc] - P[d], P[cc + 1] - P[d + 1], P[cc + 2] - P[d + 2]];
            let n = norm3(cross(du, dv));
            if (outward) {
                const o = outward(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
                if (dot(n, o) < 0) n = [-n[0], -n[1], -n[2]];
            }
            c.nrm.set(n, k * 3);
            c.part[k] = typeof part === "function" ? part(i / Math.max(1, nu - 1), j / Math.max(1, nv - 1)) : part;
            c.kind[k] = typeof kind === "function" ? kind(i / Math.max(1, nu - 1), j / Math.max(1, nv - 1)) : kind;
            c.order[k] = order(nu === 1 ? 0 : i / (nu - 1), nv === 1 ? 0 : j / (nv - 1));
        }
    }
    c.p.set(P);
    return c;
}

/**
 * A flat triangle filled with points that all share ONE normal. Built from
 * many of these, a cut gem lights a whole facet at once, like a real stone.
 * @returns {Cloud}
 */
export function facet(a, b, c, normal, { steps = 14, part = 0, kind = 0, order = () => 0 } = {}) {
    const pts = [];
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps - i; j++) pts.push([i / steps, j / steps]);
    const out = cloud(pts.length);
    const n = norm3(normal);
    pts.forEach(([u, v], k) => {
        const q = [a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v];
        out.p.set(q, k * 3);
        out.nrm.set(n, k * 3);
        out.part[k] = part;
        out.kind[k] = kind;
        out.order[k] = order(q);
    });
    return out;
}

/** Rotate a cloud about the vertical axis into `into` (allocated if missing). */
export function rotateY(c, angle, into = cloud(c.n)) {
    const cs = Math.cos(angle), sn = Math.sin(angle);
    for (let k = 0; k < c.n; k++) {
        const x = c.p[k * 3], z = c.p[k * 3 + 2], nx = c.nrm[k * 3], nz = c.nrm[k * 3 + 2];
        into.p[k * 3] = cs * x + sn * z;
        into.p[k * 3 + 1] = c.p[k * 3 + 1];
        into.p[k * 3 + 2] = -sn * x + cs * z;
        into.nrm[k * 3] = cs * nx + sn * nz;
        into.nrm[k * 3 + 1] = c.nrm[k * 3 + 1];
        into.nrm[k * 3 + 2] = -sn * nx + cs * nz;
    }
    if (into !== c) {
        into.part.set(c.part);
        into.kind.set(c.kind);
        into.order.set(c.order);
    }
    return into;
}

// ---------------------------------------------------------------- camera and light

/** A still camera looking from `eye` at `target`; `focal` is the zoom (about 2.5 to 3.2). */
export function camera(eye, target, focal = 2.9) {
    const fwd = norm3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = norm3(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    return { eye, fwd, right, up, focal, view: [-fwd[0], -fwd[1], -fwd[2]] };
}

/**
 * Perspective onto the character grid. `aspect` is the grid's pixel width
 * over its pixel height (cols * cellW / (rows * cellH)), so circles stay round
 * even though cells are taller than wide.
 */
export function project(c, cam, cols, rows, aspect, out = { sx: new Float32Array(c.n), sy: new Float32Array(c.n), z: new Float32Array(c.n) }) {
    const { eye, right, up, fwd, focal } = cam;
    for (let k = 0; k < c.n; k++) {
        const x = c.p[k * 3] - eye[0], y = c.p[k * 3 + 1] - eye[1], z = c.p[k * 3 + 2] - eye[2];
        const rx = x * right[0] + y * right[1] + z * right[2];
        const ry = x * up[0] + y * up[1] + z * up[2];
        const rz = Math.max(0.2, x * fwd[0] + y * fwd[1] + z * fwd[2]);
        out.sx[k] = (0.5 + (rx / rz) * focal * 0.5) * cols;
        out.sy[k] = (0.5 - (ry / rz) * focal * 0.5 * aspect) * rows;
        out.z[k] = rz;
    }
    return out;
}

/**
 * Brightness per point: ambient, plus how much it faces the key light, plus
 * sharp highlights (Blinn-Phong) from the key and a rim light that circles.
 * Ambient around 0.6 keeps the shadow side readable as letters.
 */
export function shade(c, { key, rim, view, ambient = 0.62, diffuse = 0.6, specular = 0.3, keyPower = 24, rimPower = 18, rimAmount = 0.7 }, out = new Float32Array(c.n)) {
    const k1 = norm3([key[0] + view[0], key[1] + view[1], key[2] + view[2]]);
    const k2 = norm3([rim[0] + view[0], rim[1] + view[1], rim[2] + view[2]]);
    for (let k = 0; k < c.n; k++) {
        const nx = c.nrm[k * 3], ny = c.nrm[k * 3 + 1], nz = c.nrm[k * 3 + 2];
        const d = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
        const s1 = Math.max(0, nx * k1[0] + ny * k1[1] + nz * k1[2]);
        const s2 = Math.max(0, nx * k2[0] + ny * k2[1] + nz * k2[2]);
        out[k] = ambient + diffuse * d + specular * (Math.pow(s1, keyPower) + rimAmount * Math.pow(s2, rimPower));
    }
    return out;
}

/**
 * The travelling light: a "head" moves through the reveal order; points behind
 * it are drawn (with a soft edge), points right at it are the bright tip that
 * draws the object. Returns visibility 0..1 and a tip flag per point.
 */
export function reveal(order, head, soft = 0.06, tipWidth = 0.03, out = { vis: new Float32Array(order.length), tip: new Uint8Array(order.length) }) {
    for (let k = 0; k < order.length; k++) {
        out.vis[k] = smooth((head - order[k]) / soft);
        out.tip[k] = Math.abs(head - order[k]) < tipWidth ? 1 : 0;
    }
    return out;
}

// ---------------------------------------------------------------- the character grid

/** Dark to bright pools of fill characters; a cell picks from its pool by a hash, so the texture shimmers instead of banding. */
export const POOLS = [".:;il!", "rcvxz=+t", "aeosun{}<>", "8B#$&%@Q"];
/** Every character a frame can use: index 0 is empty. */
export const CHARS = " " + "|/\\-_*+.'`" + POOLS.join("");
const AT = Object.fromEntries([...CHARS].map((ch, i) => [ch, i]));
const POOL_IDX = POOLS.map((p) => [...p].map((ch) => AT[ch]));

/**
 * @typedef {object} Grid
 * @property {number} cols
 * @property {number} rows
 * @property {Int32Array} part    -1 = empty
 * @property {Float32Array} depth
 * @property {Float32Array} lum
 * @property {Uint8Array} kind
 * @property {Uint8Array} char    index into CHARS
 * @property {Uint8Array} glint   1 where a sparkle sits
 */

/** @returns {Grid} */
export function grid(cols, rows) {
    const n = cols * rows;
    return { cols, rows, part: new Int32Array(n).fill(-1), depth: new Float32Array(n).fill(1e9), lum: new Float32Array(n), kind: new Uint8Array(n), char: new Uint8Array(n), glint: new Uint8Array(n) };
}

export function clearGrid(g) {
    g.part.fill(-1);
    g.depth.fill(1e9);
    g.lum.fill(0);
    g.kind.fill(0);
    g.char.fill(0);
    g.glint.fill(0);
}

/**
 * Nearest point wins: each body point lands in its cell if it is nearer than
 * what is there. `vis` (0..1) hides points the reveal has not reached; `tip`
 * points become bright glints of kind `tipKind`.
 */
export function rasterize(g, c, proj, lum, { vis = null, tip = null, tipKind = 0, glintKinds = null } = {}) {
    const { cols, rows } = g;
    for (let k = 0; k < c.n; k++) {
        const v = vis ? vis[k] : 1;
        const isTip = tip && tip[k];
        if (v < 0.96 && !isTip) continue;
        const ix = proj.sx[k] | 0, iy = proj.sy[k] | 0;
        if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) continue;
        const cell = iy * cols + ix, z = proj.z[k];
        if (z >= g.depth[cell]) continue;
        g.depth[cell] = z;
        g.part[cell] = isTip ? -2 : c.part[k];
        g.lum[cell] = isTip ? 1.2 : lum[k];
        g.kind[cell] = isTip ? tipKind : c.kind[k];
        g.glint[cell] = isTip || (glintKinds && glintKinds.has(c.kind[k])) ? 1 : 0;
    }
}

/**
 * Outlines and fill. A body cell is an edge when a neighbour (up, down, left
 * or right) is empty, or belongs to another part that sits further back by
 * more than `gap`. The sum of the directions to those outside neighbours says
 * which way the edge runs, and picks | / \ - _. Everything else is filled from
 * the pools by brightness, with a per-cell hash that drifts slowly with time.
 */
export function outlinesAndFill(g, t, { gap = 0.035, shimmer = 4 } = {}) {
    const { cols, rows, part, depth, lum, char } = g;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            if (part[i] === -1) continue;
            if (part[i] === -2) {
                char[i] = AT["*"];
                continue;
            }
            let gx = 0, gy = 0, edge = false;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const xx = x + dx, yy = y + dy;
                    const out = xx < 0 || yy < 0 || xx >= cols || yy >= rows || part[yy * cols + xx] === -1 || (part[yy * cols + xx] !== part[i] && depth[yy * cols + xx] > depth[i] + gap);
                    if (!out) continue;
                    gx += dx;
                    gy += dy;
                    if (dx === 0 || dy === 0) edge = true;
                }
            }
            if (edge) {
                const ax = Math.abs(gx), ay = Math.abs(gy);
                char[i] = ax + ay === 0 ? AT["+"] : ax > 2 * ay ? AT["|"] : ay > 2 * ax ? (gy > 0 ? AT["_"] : AT["-"]) : gx * gy > 0 ? AT["\\"] : AT["/"];
                lum[i] = Math.max(0.85, lum[i]);
            } else {
                const level = clamp(Math.floor(lum[i] * 3.2), 0, POOLS.length - 1);
                const h = (y * 7919 + x * 104729) % 9973;
                const pool = POOL_IDX[level];
                char[i] = pool[(h + Math.floor(t * shimmer + (h % 11))) % pool.length];
                lum[i] = clamp(0.45 + 0.55 * lum[i] / 0.9, 0.45, 1);
            }
            if (g.glint[i]) char[i] = AT["*"];
        }
    }
}

/**
 * A four-pointed star of light from a glint: arms of - and | (sideways arms
 * step two cells, since cells are tall), short diagonals of / and \, fading
 * out. Only writes where the cell is dimmer than the ray.
 */
export function rays(g, x, y, reach, kind, strength = 1) {
    const { cols, rows, char, lum } = g;
    const put = (xx, yy, ch, v) => {
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) return;
        const i = yy * cols + xx;
        if (lum[i] >= v) return;
        char[i] = AT[ch];
        lum[i] = v;
        g.kind[i] = kind;
    };
    for (let d = 1; d <= reach; d++) {
        const f = (1 - d / (reach + 1)) * strength;
        put(x + 2 * d, y, "-", f);
        put(x - 2 * d, y, "-", f);
        put(x, y + d, "|", f);
        put(x, y - d, "|", f);
        if (d <= reach >> 1) {
            put(x + d, y + d, "\\", f * 0.7);
            put(x - d, y - d, "\\", f * 0.7);
            put(x + d, y - d, "/", f * 0.7);
            put(x - d, y + d, "/", f * 0.7);
        }
    }
    const i = y * cols + x;
    if (x >= 0 && y >= 0 && x < cols && y < rows) {
        char[i] = AT["*"];
        lum[i] = 1;
    }
}

/**
 * Rays on the `count` brightest glints, their reach pulsing with time. The
 * stars are picked at least `spread` cells apart: neighbouring glints are
 * common (a whole facet lights at once) and their rays would stack into a fan.
 */
export function glintRays(g, t, { count = 4, kind = 0, base = 4, swing = 6, spread = 8 } = {}) {
    const all = [];
    for (let i = 0; i < g.glint.length; i++) if (g.glint[i]) all.push([g.lum[i] + ((i * 31) % 7) * 0.01, i]);
    all.sort((a, b) => b[0] - a[0]);
    const best = [];
    for (const [score, i] of all) {
        const x = i % g.cols, y = (i / g.cols) | 0;
        // cells are about twice as tall as wide, so sideways distance counts half
        if (best.some(([, j]) => Math.hypot((x - (j % g.cols)) / 2, y - ((j / g.cols) | 0)) < spread / 2)) continue;
        best.push([score, i]);
        if (best.length >= count) break;
    }
    best.forEach(([, i], n) => {
        const reach = Math.round(base + swing * (0.5 + 0.5 * Math.sin(t * 7 + n * 1.7)));
        rays(g, i % g.cols, (i / g.cols) | 0, reach, kind);
    });
}

/**
 * Particles (sparks, dust, a reflection): projected points with their own
 * glow, drawn only into empty cells and never through a nearer body cell.
 * Bright ones become *, middling +, faint . ; `dim` (a set of kinds) uses the
 * dark fill pools instead, for reflections.
 */
export function particles(g, proj, glow, kinds, { dim = null } = {}) {
    const { cols, rows } = g;
    for (let k = 0; k < glow.length; k++) {
        const v = glow[k];
        if (v <= 0.02) continue;
        const ix = proj.sx[k] | 0, iy = proj.sy[k] | 0;
        if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) continue;
        const i = iy * cols + ix;
        if (g.part[i] !== -1 && g.depth[i] < proj.z[k]) continue;
        if (g.part[i] !== -1) continue;
        if (g.lum[i] >= v) continue;
        if (dim && dim.has(kinds[k])) {
            g.char[i] = POOL_IDX[v > 0.15 ? 1 : 0][(i * 31) % POOL_IDX[0].length];
        } else {
            g.char[i] = v > 0.7 ? AT["*"] : v > 0.35 ? AT["+"] : AT["."];
        }
        g.lum[i] = clamp(v);
        g.kind[i] = kinds[k];
    }
}

// ---------------------------------------------------------------- the renderer

/**
 * Draws a grid on a canvas: every character pre-rendered once per colour and
 * brightness step (an atlas), so a frame is one drawImage per cell; the last
 * frames linger as trails; a blurred copy is added on top as glow.
 *
 * @param {HTMLCanvasElement} canvas  sized cols * cellW by rows * cellH (times dpr)
 * @param {{ cols: number, rows: number, cellW: number, cellH: number, font?: string, palette: number[][], levels?: number, trail?: number, glow?: number, dpr?: number }} o
 */
export function createRenderer(canvas, o) {
    const dpr = o.dpr ?? 1, levels = o.levels ?? 8, trail = o.trail ?? 0.5, glow = o.glow ?? 0.55;
    const cw = Math.round(o.cellW * dpr), ch = Math.round(o.cellH * dpr);
    const W = o.cols * cw, H = o.rows * ch;
    canvas.width = W;
    canvas.height = H;
    const out = canvas.getContext("2d");
    const mk = (w, h) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return [c, c.getContext("2d")];
    };
    const [frame, fx] = mk(W, H);
    const [keep, kx] = mk(W, H);
    const [blurA, ax] = mk(Math.max(1, W >> 2), Math.max(1, H >> 2));
    const [blurB, bx] = mk(Math.max(1, Math.round(W / 10)), Math.max(1, Math.round(H / 10)));
    // the atlas: one row per (kind, level), one column per character
    const [atlas, tx] = mk(CHARS.length * cw, o.palette.length * levels * ch);
    tx.font = o.font ?? `${Math.round(ch * 0.95)}px ui-monospace, Menlo, Consolas, monospace`;
    tx.textAlign = "center";
    tx.textBaseline = "middle";
    o.palette.forEach((rgb, k) => {
        for (let l = 0; l < levels; l++) {
            const f = (l + 1) / levels;
            tx.fillStyle = `rgb(${rgb[0] * f | 0}, ${rgb[1] * f | 0}, ${rgb[2] * f | 0})`;
            for (let c = 1; c < CHARS.length; c++) tx.fillText(CHARS[c], c * cw + cw / 2, (k * levels + l) * ch + ch / 2);
        }
    });

    /** @param {Grid} g */
    function draw(g) {
        fx.fillStyle = "#000";
        fx.fillRect(0, 0, W, H);
        for (let i = 0; i < g.char.length; i++) {
            const c = g.char[i];
            if (!c) continue;
            const l = clamp(Math.round(g.lum[i] * levels) - 1, 0, levels - 1);
            const row = g.kind[i] * levels + l;
            fx.drawImage(atlas, c * cw, row * ch, cw, ch, (i % g.cols) * cw, ((i / g.cols) | 0) * ch, cw, ch);
        }
        // trails: the kept picture fades, the new frame is laid over it, brightest wins
        kx.globalCompositeOperation = "source-over";
        kx.globalAlpha = 1 - trail;
        kx.fillStyle = "#000";
        kx.fillRect(0, 0, W, H);
        kx.globalAlpha = 1;
        kx.globalCompositeOperation = "lighten";
        kx.drawImage(frame, 0, 0);
        // glow: two blurred copies, made by shrinking, added as light
        ax.clearRect(0, 0, blurA.width, blurA.height);
        ax.drawImage(keep, 0, 0, blurA.width, blurA.height);
        bx.clearRect(0, 0, blurB.width, blurB.height);
        bx.drawImage(blurA, 0, 0, blurB.width, blurB.height);
        out.globalCompositeOperation = "source-over";
        out.globalAlpha = 1;
        out.drawImage(keep, 0, 0);
        out.globalCompositeOperation = "lighter";
        out.globalAlpha = glow;
        out.drawImage(blurA, 0, 0, W, H);
        out.globalAlpha = glow * 0.8;
        out.drawImage(blurB, 0, 0, W, H);
        out.globalCompositeOperation = "source-over";
        out.globalAlpha = 1;
    }
    return { draw, width: W, height: H };
}
