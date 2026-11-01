import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-home-'))

const host = await import('../index.js')

function fakeContext() {
  const routes = new Map()
  let injectListener = null
  const ctx = {
    logger: { warn() {}, info() {} },
    on(event, cb) {
      if (event === 'webserver/index-inject') injectListener = cb
    },
    inject(_deps, cb) {
      cb({
        effect(fn) {
          return fn()
        },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
      })
    },
  }
  return { ctx, routes, emitInjection: () => { const table = []; injectListener(table); return table } }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
  }
}

test('host injects every skin and registers media + manifest routes', () => {
  const { ctx, routes, emitInjection } = fakeContext()
  host.apply(ctx)
  const table = emitInjection()
  assert.equal(table.length, 2)
  assert.equal(table[0].kind, 'style')
  assert.equal(table[1].kind, 'script')
  assert.ok(table[1].text.includes('NEON GRID'))
  assert.ok(routes.has('/dsh-abyss-skin/skins/abyss/boot.mp4'))
  assert.ok(routes.has('/dsh-abyss-skin/skins/neon/background.mp4'))
  assert.ok(routes.has('/dsh-abyss-skin/skins/abyss/poster.jpg'))
  assert.ok(routes.has('/dsh-abyss-skin/skins/vermilion/audio/line-1.mp3'))
  assert.ok(routes.has('/dsh-abyss-skin/skins/vermilion/audio/sfx-tick.mp3'))
  assert.ok(routes.has('/dsh-abyss-skin/api/manifest'))
  assert.ok(routes.has('/dsh-abyss-skin/api/active'))
})

test('manifest exposes four switchable skins and stable routes', () => {
  const { ctx, routes, emitInjection } = fakeContext()
  host.apply(ctx)
  emitInjection()
  const res = fakeResponse()
  routes.get('/dsh-abyss-skin/api/manifest')({ method: 'GET', headers: {} }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(body.version, '1.6.0')
  assert.equal(body.active, 'neon')
  assert.equal(body.skins.length, 4)
  assert.deepEqual(body.skins.map((skin) => skin.id).sort(), ['abyss', 'muse', 'neon', 'vermilion'])
  assert.equal(body.skins[0].poster, '/dsh-abyss-skin/skins/abyss/poster.jpg')
  assert.ok(body.skins.filter((skin) => skin.boot.video).every((skin) => skin.boot.src.includes('/skins/')))
  assert.ok(body.skins.every((skin) => skin.background.src.includes('/skins/')))
  const muse = body.skins.find((skin) => skin.id === 'muse')
  assert.equal(muse.background.gallery, true)
  assert.ok(muse.background.images.length >= 1)
  assert.ok(muse.background.images.every((url) => url.startsWith('/dsh-abyss-skin/skins/muse/')))
  assert.ok(routes.has('/dsh-abyss-skin/skins/muse/poster.jpg'))
  const vermilion = body.skins.find((skin) => skin.id === 'vermilion')
  assert.equal(vermilion.boot.video, false)
  assert.equal(vermilion.boot.src, '')
  assert.ok(!routes.has('/dsh-abyss-skin/skins/vermilion/boot.mp4'))
  assert.equal(vermilion.background.kind, 'image')
  assert.equal(vermilion.background.src, '/dsh-abyss-skin/skins/vermilion/poster.jpg')
  assert.equal(vermilion.phases.length, 6)
  assert.deepEqual(vermilion.phases.map((phase) => phase.id), [
    'permission',
    'identity',
    'request',
    'reading',
    'verified',
    'welcome',
  ])
  assert.equal(vermilion.phases[0].interactive, true)
  assert.equal(vermilion.rite.stamp, '核验通过')
  assert.equal(vermilion.audio.enabled, true)
  assert.equal(vermilion.audio.base, '/dsh-abyss-skin/skins/vermilion/audio/')
  assert.deepEqual(vermilion.audio.files, [
    'line-1',
    'line-2',
    'line-3',
    'line-4',
    'line-5',
    'line-6',
    'sfx-tick',
    'sfx-ticks-run',
  ])
  assert.deepEqual(vermilion.phases.map((phase) => phase.audio), [
    'line-1',
    'line-2',
    'line-3',
    'line-4',
    'line-5',
    'line-6',
  ])
  assert.equal(vermilion.boot.voice.enabled, true)
  assert.equal(vermilion.boot.voice.cue, true)
  assert.equal(vermilion.boot.voice.lead, 240)
  assert.equal(vermilion.boot.sfx.enabled, true)
})

test('gallery auto-discovery picks up safe images in sorted order', () => {
  const dir = path.join(root, 'skins', 'muse', 'images')
  const a = path.join(dir, 'zztest01.jpg')
  const b = path.join(dir, 'zztest02.jpg')
  fs.copyFileSync(path.join(root, 'skins', 'muse', 'poster.jpg'), a)
  fs.copyFileSync(path.join(root, 'skins', 'muse', 'poster.jpg'), b)
  try {
    const { ctx, routes, emitInjection } = fakeContext()
    host.apply(ctx)
    emitInjection()
    const res = fakeResponse()
    routes.get('/dsh-abyss-skin/api/manifest')({ method: 'GET', headers: {} }, res)
    const body = JSON.parse(res.body)
    const muse = body.skins.find((skin) => skin.id === 'muse')
    assert.ok(muse.background.images.includes('/dsh-abyss-skin/skins/muse/images/zztest01.jpg'))
    assert.ok(muse.background.images.includes('/dsh-abyss-skin/skins/muse/images/zztest02.jpg'))
    assert.ok(routes.has('/dsh-abyss-skin/skins/muse/images/zztest01.jpg'))
  } finally {
    fs.rmSync(a, { force: true })
    fs.rmSync(b, { force: true })
  }
})

test('active endpoint rejects unknown skins', () => {
  const { ctx, routes, emitInjection } = fakeContext()
  host.apply(ctx)
  emitInjection()
  const req = {
    method: 'POST',
    headers: {},
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify({ active: 'does-not-exist' })))
      if (event === 'end') cb()
      return this
    },
    destroy() {},
  }
  const res = fakeResponse()
  routes.get('/dsh-abyss-skin/api/active')(req, res)
  assert.equal(res.status, 400)
  assert.match(JSON.parse(res.body).error, /unknown skin/)
})

test('boot.voice can be switched off and its numbers are clamped', () => {
  const file = path.join(process.env.DSH_HOME, 'dsh-abyss-skin.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      active: 'vermilion',
      skins: {
        vermilion: { boot: { sound: false, voice: { enabled: false, volume: 3, lead: 99999 } } },
      },
    }),
  )
  try {
    const { ctx, routes, emitInjection } = fakeContext()
    host.apply(ctx)
    emitInjection()
    const res = fakeResponse()
    routes.get('/dsh-abyss-skin/api/manifest')({ method: 'GET', headers: {} }, res)
    const vermilion = JSON.parse(res.body).skins.find((skin) => skin.id === 'vermilion')
    assert.equal(vermilion.boot.sound, false)
    assert.equal(vermilion.boot.voice.enabled, false)
    assert.equal(vermilion.boot.voice.volume, 1)
    assert.equal(vermilion.boot.voice.lead, 1200)
    /* one kill switch: no film sound means no voice and no sfx either */
    assert.equal(vermilion.boot.sfx.enabled, false)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('a skin without lib/assets advertises no audio', () => {
  const { ctx, routes, emitInjection } = fakeContext()
  host.apply(ctx)
  emitInjection()
  const res = fakeResponse()
  routes.get('/dsh-abyss-skin/api/manifest')({ method: 'GET', headers: {} }, res)
  const abyss = JSON.parse(res.body).skins.find((skin) => skin.id === 'abyss')
  assert.equal(abyss.audio.enabled, false)
  assert.deepEqual(abyss.audio.files, [])
  assert.ok(!routes.has('/dsh-abyss-skin/skins/abyss/audio/line-1.mp3'))
})
