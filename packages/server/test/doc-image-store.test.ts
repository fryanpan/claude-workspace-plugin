import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageStem, sniffImage, storeImageBeside } from '../src/doc-image-store.ts';
import { tinyPng } from './tiny-png.ts';

describe('sniffImage', () => {
  it('names the four raster types by their first bytes', () => {
    expect(sniffImage(tinyPng())).toBe('.png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('.jpg');
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBe('.gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('.webp');
  });

  it('answers null for anything else, SVG included', () => {
    expect(sniffImage(new TextEncoder().encode('<svg/>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WAVE'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe('imageStem', () => {
  it('keeps a readable, path-free stem of the name it was given', () => {
    expect(imageStem('Harborlight Chart.PNG')).toBe('harborlight-chart');
    expect(imageStem('../../etc/passwd')).toBe('passwd');
    expect(imageStem('a\\b\\Riverbend map.jpg')).toBe('riverbend-map');
    expect(imageStem('')).toBe('image');
    expect(imageStem(null)).toBe('image');
    expect(imageStem('….png')).toBe('image');
    expect(imageStem('x'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('storeImageBeside', () => {
  it('takes the next name when one is already held, and leaves the held file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-image-store-'));
    mkdirSync(join(dir, 'images'));
    writeFileSync(join(dir, 'images', 'chart-aaaaaaaa.png'), 'already here');
    const names = ['aaaaaaaa', 'bbbbbbbb'];
    const out = storeImageBeside(join(dir, 'doc.md'), tinyPng(), '.png', 'chart', () => {
      const next = names.shift();
      if (!next) throw new Error('asked for a third name');
      return next;
    });
    expect(out).toEqual({ ok: true, src: 'images/chart-bbbbbbbb.png' });
    expect(readFileSync(join(dir, 'images', 'chart-aaaaaaaa.png'), 'utf8')).toBe('already here');
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives up rather than loop when every name it tries is held', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-image-store-'));
    mkdirSync(join(dir, 'images'));
    writeFileSync(join(dir, 'images', 'chart-same.png'), 'held');
    const out = storeImageBeside(join(dir, 'doc.md'), tinyPng(), '.png', 'chart', () => 'same');
    expect(out).toEqual({ ok: false, reason: 'no-free-name' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an images entry that is a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-image-store-'));
    writeFileSync(join(dir, 'images'), 'a file, not a folder');
    const out = storeImageBeside(join(dir, 'doc.md'), tinyPng(), '.png', 'chart');
    expect(out).toEqual({ ok: false, reason: 'not-a-folder' });
    rmSync(dir, { recursive: true, force: true });
  });
});
