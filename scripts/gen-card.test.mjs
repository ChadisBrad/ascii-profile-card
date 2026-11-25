// Run: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCard, readConfig, checkConfig, renderFrames, frameSvg, esc, FRAMES, ART } from './gen-card.mjs';
import { CHARS } from './ascii3d.mjs';

const cfg = readConfig();
const svg = buildCard(cfg);

test('the card shows every line from profile.config.json', () => {
  assert.ok(svg.includes(esc(cfg.name)));
  assert.ok(svg.includes(esc(cfg.tagline)));
  for (const [label, value] of cfg.facts) {
    assert.ok(svg.includes(`>${esc(label)}<`), `missing label ${label}`);
    assert.ok(svg.includes(`>${esc(value)}<`), `missing value ${value}`);
  }
});

test('the card has one group per animation frame and a reduced-motion fallback', () => {
  assert.equal((svg.match(/<g class="f f\d+">/g) ?? []).length, FRAMES);
  assert.match(svg, /prefers-reduced-motion:reduce/);
});

test('the card loads nothing from outside, so GitHub shows it as is', () => {
  assert.doesNotMatch(svg, /href=/);
  assert.doesNotMatch(svg, /url\((?!#)/);
  assert.doesNotMatch(svg, /@import|<image|<script/);
});

test('the card stays small enough for GitHub image proxying', () => {
  assert.ok(Buffer.byteLength(svg) < 400 * 1024, `card is ${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB`);
});

test('every ampersand and angle bracket in the art is escaped', () => {
  const body = svg.slice(svg.indexOf('<g class="art"'));
  assert.doesNotMatch(body, /&(?!amp;|lt;|gt;|quot;)/);
  for (const t of body.match(/<text[^>]*>[\s\S]*?<\/text>/g) ?? []) {
    const inner = t.replace(/^<text[^>]*>/, '').replace(/<\/text>$/, '').replace(/<\/?tspan[^>]*>/g, '');
    assert.doesNotMatch(inner, /[<>]/);
  }
});

const keepsClearOfEdges = (frames) => {
  for (const fr of frames) {
    const drawn = fr.char.reduce((n, c) => n + (c ? 1 : 0), 0);
    assert.ok(drawn > ART.cols * ART.rows * 0.15, `only ${drawn} cells drawn`);
    for (let x = 0; x < ART.cols; x++) {
      for (const y of [0, ART.rows - 1]) {
        const c = fr.char[y * ART.cols + x];
        assert.ok(c === 0 || '*+.'.includes(CHARS[c]), `letter touches the edge at ${x},${y}`);
      }
    }
  }
};

test('the default S is drawn in every frame and stays inside the art area', () => {
  keepsClearOfEdges(renderFrames(6));
});

test('a custom letter from shape.spine is drawn and stays inside the art area', () => {
  const L = { spine: [[-0.55, 1], [-0.55, -1], [0.6, -1]], thickness: 0.25 };
  const frames = renderFrames(4, { shape: L });
  keepsClearOfEdges(frames);
  const S = renderFrames(1)[0];
  assert.notDeepEqual(frames[0].char, S.char, 'custom spine drew the same picture as the default S');
});

test('a frame only uses characters from the engine set', () => {
  const text = frameSvg(renderFrames(1)[0]).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const ch of text) assert.ok(CHARS.includes(ch), `unexpected character ${JSON.stringify(ch)}`);
});

test('refuses a config with a missing name, naming the field', () => {
  const file = path.join(os.tmpdir(), `card-cfg-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ tagline: 'x', facts: [['a', 'b']] }));
  try {
    assert.throws(() => readConfig(file), /"name" must be a non-empty string/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('refuses a fact value too long for the card', () => {
  assert.throws(() => checkConfig({ name: 'n', tagline: 't', facts: [['role', 'x'.repeat(60)]] }), /facts\[0\] value is 60 characters/);
});

test('refuses a spine point outside the drawing box', () => {
  assert.throws(() => checkConfig({ name: 'n', tagline: 't', facts: [['a', 'b']], shape: { spine: [[0, 0], [1.4, 0]] } }), /shape\.spine/);
});

test('refuses a stroke too thin or too thick to read', () => {
  assert.throws(() => checkConfig({ name: 'n', tagline: 't', facts: [['a', 'b']], shape: { thickness: 0.6 } }), /shape\.thickness/);
});
