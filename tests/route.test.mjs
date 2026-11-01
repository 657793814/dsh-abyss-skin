import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  clampNumber,
  contentTypeFor,
  parseRange,
  resolveAsset,
  toInlineJson,
} from '../lib/route.js'

test('parseRange handles full, closed, open and suffix ranges', () => {
  assert.deepEqual(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=10-20', 100), { start: 10, end: 20 })
  assert.deepEqual(parseRange('bytes=10-999', 100), { start: 10, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
})

test('parseRange rejects unsatisfiable and malformed values', () => {
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=20-10', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=abc-def', 100), null)
})

test('content types cover the shipped media', () => {
  assert.equal(contentTypeFor('boot.mp4'), 'video/mp4')
  assert.equal(contentTypeFor('bg.WEBM'), 'video/webm')
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream')
  assert.equal(contentTypeFor('line-1.MP3'), 'audio/mpeg')
  assert.equal(contentTypeFor('clip.m4a'), 'audio/mp4')
})

test('relative assets cannot escape the package', () => {
  const root = '/tmp/abyss-package'
  assert.equal(resolveAsset(root, 'assets/boot.mp4'), path.join(root, 'assets/boot.mp4'))
  assert.throws(() => resolveAsset(root, '../../.credentials.yaml'), /escapes/)
  assert.equal(resolveAsset(root, '/tmp/movie.mp4'), '/tmp/movie.mp4')
})

test('inline JSON cannot close the script element', () => {
  const text = toInlineJson({ hint: '</script><script>alert(1)</script>' })
  assert.ok(!text.includes('</script>'))
  assert.ok(text.includes('\\u003c/script>'))
})

test('clampNumber keeps infinities at the boundary', () => {
  assert.equal(clampNumber(Number.NaN, 0.25, 0, 1), 0.25)
  assert.equal(clampNumber(Infinity, 0.25, 0, 1), 1)
  assert.equal(clampNumber(-Infinity, 0.25, 0, 1), 0)
  assert.equal(clampNumber('0.4', 0.25, 0, 1), 0.4)
})
