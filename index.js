/**
 * dsh-abyss-skin — host half for a multi-skin DSH video shell.
 *
 * Responsibilities:
 *   1. discover every skin pack under `skins/<id>/skin.json`;
 *   2. inject one style row + one script row through `webserver/index-inject`,
 *      with a manifest of *all* skins so the client can switch without a host
 *      restart;
 *   3. serve each skin's boot film, loop film and poster with HTTP Range, and
 *      persist the active skin through a tiny JSON endpoint.
 *
 * The desktop shell snapshots the injection table once at host boot. That is
 * why the injected payload contains every skin: switching then only needs a
 * page reload (or a live video swap), not a new snapshot.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clampNumber,
  contentTypeFor,
  isPlainObject,
  parseRange,
  resolveAsset,
  toInlineJson,
} from './lib/route.js'

export const name = 'abyss-skin'
export const inject = []

const PREFIX = '/dsh-abyss-skin'
const VERSION = '1.6.0'

const DEFAULT_GLOBAL = Object.freeze({
  active: 'neon',
  boot: Object.freeze({
    sound: true,
    volume: 0.85,
    fadeMs: 1200,
    skipFadeMs: 280,
    maxMs: 16000,
    hint: '正在接入协议…',
    skipLabel: '点击跳过',
  }),
  background: Object.freeze({
    delayMs: 600,
  }),
  ui: Object.freeze({
    switcher: true,
  }),
})

const DEFAULT_SKIN = Object.freeze({
  enabled: true,
  name: 'UNTITLED',
  tagline: 'DSH SKIN',
  description: '',
  accent: '#5fe8ff',
  accent2: '#a78bfa',
  boot: Object.freeze({
    enabled: true,
    file: 'boot.mp4',
    sound: true,
    volume: 0.85,
  }),
  background: Object.freeze({
    enabled: true,
    file: 'background.mp4',
    images: [],
    gallery: false,
    intervalMs: 15000,
    veil: 0.18,
    surface: 0.26,
    sidebar: 0.42,
    playbackRate: 0.82,
  }),
  chrome: Object.freeze({
    kicker: 'DEEPSEEK HARNESS',
    title: 'DSH SKIN',
    subtitle: 'NEURAL SHELL',
  }),
})

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectOrEmpty(value) {
  return isPlainObject(value) ? value : {}
}

/**
 * Read a JSON object; never throw into the host.
 * @param {string} file
 * @param {string[]} warnings
 * @returns {Record<string, unknown>}
 */
function readJson(file, warnings) {
  try {
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isPlainObject(parsed)) {
      warnings.push(`${path.basename(file)} must contain a JSON object`)
      return {}
    }
    return parsed
  } catch (error) {
    warnings.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

/**
 * @param {Record<string, unknown>} base
 * @param {unknown} patch
 * @returns {Record<string, unknown>}
 */
function merge(base, patch) {
  const p = objectOrEmpty(patch)
  return { ...base, ...p }
}

/**
 * Safe, sorted list of gallery images in a skin's images/ directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listGalleryImages(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-z0-9][a-z0-9._-]*\.(jpe?g|png|webp)$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'))
      .slice(0, 24)
  } catch {
    return []
  }
}

/**
 * A still image can stand in for the looping film. The runtime swaps <video>
 * for <img> when `background.kind` is `image`.
 * @param {string} file
 * @returns {boolean}
 */
function isImageFile(file) {
  return /\.(?:jpe?g|png|webp|avif|gif)$/iu.test(String(file))
}

/**
 * Audio clips shipped in `<skin>/lib/assets`. Only flat, lowercase-safe names:
 * the route table is built from this list, so a weird filename cannot become
 * a path. Sorted so the manifest (and its tests) stay stable.
 * @param {string} dir
 * @returns {string[]}
 */
function listSounds(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, 'lib', 'assets'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-z0-9][a-z0-9._-]*\.mp3$/iu.test(entry.name))
      .map((entry) => entry.name.replace(/\.mp3$/iu, ''))
      .sort((a, b) => a.localeCompare(b, 'en'))
  } catch {
    return []
  }
}

/**
 * @param {string} packageRoot
 * @param {string[]} warnings
 * @returns {Array<Record<string, any>>}
 */
function discoverSkins(packageRoot, warnings) {
  const root = path.join(packageRoot, 'skins')
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    warnings.push(`skins directory is missing: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }

  const skins = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const meta = readJson(path.join(dir, 'skin.json'), warnings)
    if (Object.keys(meta).length === 0) {
      warnings.push(`skins/${entry.name}/skin.json is missing or invalid`)
      continue
    }
    const id = typeof meta.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/iu.test(meta.id) ? meta.id : entry.name
    if (skins.some((skin) => skin.id === id)) {
      warnings.push(`duplicate skin id "${id}" ignored`)
      continue
    }
    const boot = merge(DEFAULT_SKIN.boot, meta.boot)
    const background = merge(DEFAULT_SKIN.background, meta.background)
    const chrome = merge(DEFAULT_SKIN.chrome, meta.chrome)
    if (background.images === 'auto' || background.gallery === true) {
      background.gallery = true
      background.images = listGalleryImages(path.join(dir, 'images'))
    } else {
      background.gallery = false
      background.images = []
    }
    skins.push({
      id,
      dir,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id.toUpperCase(),
      tagline: typeof meta.tagline === 'string' ? meta.tagline : DEFAULT_SKIN.tagline,
      description: typeof meta.description === 'string' ? meta.description : '',
      accent: typeof meta.accent === 'string' ? meta.accent : DEFAULT_SKIN.accent,
      accent2: typeof meta.accent2 === 'string' ? meta.accent2 : DEFAULT_SKIN.accent2,
      enabled: meta.enabled !== false,
      boot,
      background,
      chrome,
      phases: Array.isArray(meta.phases) ? meta.phases : [],
      rite: isPlainObject(meta.rite) ? meta.rite : null,
      audio: listSounds(dir),
      poster: typeof meta.poster === 'string' && meta.poster ? meta.poster : 'poster.jpg',
    })
  }
  skins.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'))
  return skins
}

/**
 * @param {string} packageRoot
 * @param {string} homeDir
 * @param {string[]} warnings
 * @returns {{ active: string, boot: Record<string, unknown>, background: Record<string, unknown>, ui: Record<string, unknown>, skins: Array<Record<string, any>> }}
 */
function loadState(packageRoot, homeDir, warnings) {
  const fileConfig = readJson(path.join(packageRoot, 'abyss-skin.config.json'), warnings)
  const homeConfig = readJson(path.join(homeDir, 'dsh-abyss-skin.json'), warnings)

  const config = {
    ...fileConfig,
    ...homeConfig,
    boot: merge(merge(DEFAULT_GLOBAL.boot, fileConfig.boot), homeConfig.boot),
    background: merge(merge(DEFAULT_GLOBAL.background, fileConfig.background), homeConfig.background),
    ui: merge(merge(DEFAULT_GLOBAL.ui, fileConfig.ui), homeConfig.ui),
    skins: merge(objectOrEmpty(fileConfig.skins), homeConfig.skins),
  }

  if (typeof config.active !== 'string' || config.active === '') config.active = DEFAULT_GLOBAL.active
  const skins = discoverSkins(packageRoot, warnings).map((skin) => {
    const override = objectOrEmpty(config.skins[skin.id])
    return {
      ...skin,
      boot: merge(skin.boot, override.boot),
      background: merge(skin.background, override.background),
      chrome: merge(skin.chrome, override.chrome),
    }
  })
  const enabled = skins.filter((skin) => skin.enabled !== false)
  const requested = typeof config.active === 'string' ? config.active : ''
  const active = enabled.some((skin) => skin.id === requested)
    ? requested
    : (enabled[0]?.id ?? '')
  return {
    active,
    boot: config.boot,
    background: config.background,
    ui: config.ui,
    skins: enabled,
  }
}

/**
 * Public manifest: no absolute paths, only routes and effective values.
 * @param {ReturnType<typeof loadState>} state
 * @param {string} version
 * @returns {Record<string, any>}
 */
function buildClient(state, version) {
  const boot = state.boot
  const background = state.background
  const skins = state.skins.map((skin) => {
    const soundOn = boot.sound !== false && skin.boot.sound !== false
    const voiceRaw = isPlainObject(skin.boot.voice) ? skin.boot.voice : {}
    const sfxRaw = isPlainObject(skin.boot.sfx) ? skin.boot.sfx : {}
    const sounds = Array.isArray(skin.audio) ? skin.audio : []
    const hasBootVideo = skin.boot.video !== false
    const skinBoot = {
      enabled: skin.boot.enabled !== false,
      video: hasBootVideo,
      src: hasBootVideo
        ? `${PREFIX}/skins/${skin.id}/${String(skin.boot.file || DEFAULT_GLOBAL.boot.file)}`
        : '',
      sound: soundOn,
      volume: clampNumber(skin.boot.volume ?? boot.volume, 0.85, 0, 1),
      fadeMs: clampNumber(boot.fadeMs, 1200, 200, 6000),
      skipFadeMs: clampNumber(boot.skipFadeMs, 280, 80, 2000),
      maxMs: clampNumber(boot.maxMs, 16000, 5000, 30000),
      hint: typeof boot.hint === 'string' ? boot.hint : DEFAULT_GLOBAL.boot.hint,
      skipLabel: typeof boot.skipLabel === 'string' ? boot.skipLabel : DEFAULT_GLOBAL.boot.skipLabel,
      voice: {
        enabled: soundOn && voiceRaw.enabled !== false,
        volume: clampNumber(voiceRaw.volume, 0.9, 0, 1),
        cue: voiceRaw.cue !== false,
        lead: clampNumber(voiceRaw.lead, 240, 0, 1200),
      },
      sfx: {
        enabled: soundOn && sfxRaw.enabled !== false,
        volume: clampNumber(sfxRaw.volume, 0.5, 0, 1),
      },
    }
    const isGallery = skin.background.gallery === true
    const imageFiles = isGallery && Array.isArray(skin.background.images)
      ? skin.background.images.filter((file) => typeof file === 'string' && file)
      : []
    const imageRoutes = imageFiles.map((file) => `${PREFIX}/skins/${skin.id}/images/${file}`)
    if (isGallery && imageRoutes.length === 0) {
      imageRoutes.push(`${PREFIX}/skins/${skin.id}/poster.jpg`)
    }
    const backgroundFile = String(skin.background.file || DEFAULT_GLOBAL.background.file)
    const skinBackground = {
      enabled: skin.background.enabled !== false,
      kind: isGallery ? 'gallery' : (isImageFile(backgroundFile) ? 'image' : 'video'),
      src: isGallery
        ? (imageRoutes[0] || `${PREFIX}/skins/${skin.id}/poster.jpg`)
        : `${PREFIX}/skins/${skin.id}/${backgroundFile}`,
      images: isGallery ? imageRoutes : [],
      gallery: isGallery,
      intervalMs: clampNumber(skin.background.intervalMs, 15000, 3000, 120000),
      veil: clampNumber(skin.background.veil, 0.18, 0, 0.92),
      surface: clampNumber(skin.background.surface, 0.26, 0, 1),
      sidebar: clampNumber(skin.background.sidebar, 0.42, 0, 1),
      playbackRate: clampNumber(skin.background.playbackRate, 0.82, 0.25, 2),
      delayMs: clampNumber(background.delayMs, 600, 0, 10000),
    }
    const phases = (Array.isArray(skin.phases) ? skin.phases : []).map((phase) => {
      const audio = phase && typeof phase.audio === 'string' && sounds.includes(phase.audio) ? phase.audio : ''
      return { ...phase, audio }
    })
    return {
      id: skin.id,
      name: skin.name,
      tagline: skin.tagline,
      description: skin.description,
      accent: skin.accent,
      accent2: skin.accent2,
      poster: `${PREFIX}/skins/${skin.id}/poster.jpg`,
      boot: skinBoot,
      background: skinBackground,
      chrome: skin.chrome,
      audio: {
        enabled: sounds.length > 0,
        base: `${PREFIX}/skins/${skin.id}/audio/`,
        files: sounds,
      },
      phases,
      rite: skin.rite,
    }
  })
  return {
    version,
    active: state.active,
    skins,
    ui: { switcher: state.ui.switcher !== false },
  }
}

/**
 * Absolute path of a gallery image inside a skin.
 * @param {Record<string, any>} skin
 * @param {string} file
 * @returns {string}
 */
function imageAsset(skin, file) {
  return resolveAsset(skin.dir, path.join('images', String(file)))
}

/**
 * Absolute path of a skin asset, with the same escape guard as v1.
 * @param {Record<string, any>} skin
 * @param {'boot'|'background'|'poster'} key
 * @returns {string}
 */
function skinAsset(skin, key) {
  if (key === 'poster') {
    const chosen = resolveAsset(skin.dir, skin.poster)
    if (fs.existsSync(chosen)) return chosen
    const fallback = resolveAsset(skin.dir, 'poster.jpg')
    return fs.existsSync(fallback) ? fallback : chosen
  }
  const chosen = resolveAsset(skin.dir, String(skin[key].file))
  if (fs.existsSync(chosen)) return chosen
  const fallback = resolveAsset(skin.dir, `${key}.mp4`)
  return fs.existsSync(fallback) ? fallback : chosen
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 */
function serveAsset(req, res, filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('abyss asset not found')
    return
  }

  const size = stat.size
  const etag = `"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
  const range = parseRange(req.headers.range, size)

  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    res.end()
    return
  }

  /** @type {Record<string, string | number>} */
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }

  if (range !== null) {
    headers['Cache-Control'] = 'no-store'
    headers['Content-Length'] = range.end - range.start + 1
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    res.writeHead(206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(filePath, { start: range.start, end: range.end })
      .on('error', () => res.destroy())
      .pipe(res)
    return
  }

  headers['Cache-Control'] = 'no-cache'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['Content-Length'] = size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res)
}

/**
 * Persist only `active` into $DSH_HOME/dsh-abyss-skin.json, preserving keys
 * written by other versions or by hand.
 * @param {string} homeDir
 * @param {string} active
 * @returns {string}
 */
function persistActive(homeDir, active) {
  const file = path.join(homeDir, 'dsh-abyss-skin.json')
  const current = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  })()
  current.active = active
  fs.mkdirSync(homeDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url))
  const homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[abyss-skin] ${message}`)
    } catch {
      /* logging is never fatal */
    }
  }

  /** @returns {ReturnType<typeof loadState>} */
  const current = () => {
    const warnings = []
    const state = loadState(packageRoot, homeDir, warnings)
    for (const warning of warnings) warn(warning)
    return state
  }

  // 1. Synchronous injection subscription: the desktop shell snapshots once.
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    try {
      const state = current()
      const client = buildClient(state, VERSION)
      const css = fs.readFileSync(path.join(packageRoot, 'runtime', 'skin.css'), 'utf8')
      const js = fs.readFileSync(path.join(packageRoot, 'runtime', 'skin.js'), 'utf8')
      table.push({ kind: 'style', text: css })
      table.push({
        kind: 'script',
        placement: 'body',
        text: `globalThis.__DSH_ABYSS__=${toInlineJson(client)};\n${js}`,
      })
    } catch (error) {
      warn(`index injection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 2. HTTP surface: manifest, active switch, and every skin's media.
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = []
      const reply = (res, status, body) => {
        const text = JSON.stringify(body)
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
        })
        res.end(text)
      }

      // Manifest is read at page load; it also lets a reload pick up a skin
      // switched from another tab.
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/api/manifest`,
          handler: (req, res) => {
            try {
              const state = current()
              reply(res, 200, buildClient(state, VERSION))
            } catch (error) {
              reply(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/api/active`,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            const state = current()
            if (method === 'GET') {
              reply(res, 200, { active: state.active, skins: state.skins.map((skin) => skin.id) })
              return
            }
            if (method !== 'POST') {
              reply(res, 405, { error: 'use GET or POST' })
              return
            }
            const chunks = []
            let size = 0
            let aborted = false
            req.on('data', (chunk) => {
              if (aborted) return
              size += chunk.length
              if (size > 4096) {
                aborted = true
                reply(res, 413, { error: 'body too large' })
                req.destroy()
                return
              }
              chunks.push(chunk)
            })
            req.on('error', () => {
              if (!aborted) reply(res, 400, { error: 'request stream failed' })
            })
            req.on('end', () => {
              if (aborted) return
              let parsed
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch (error) {
                reply(res, 400, { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` })
                return
              }
              const active = parsed && typeof parsed.active === 'string' ? parsed.active : ''
              if (!state.skins.some((skin) => skin.id === active)) {
                reply(res, 400, { error: `unknown skin: ${active}` })
                return
              }
              try {
                const file = persistActive(homeDir, active)
                reply(res, 200, { ok: true, active, file })
              } catch (error) {
                reply(res, 500, { error: error instanceof Error ? error.message : String(error) })
              }
            })
          },
        }),
      )

      const state = current()
      for (const skin of state.skins) {
        const imageFiles = Array.isArray(skin.background.images) ? skin.background.images : []
        for (const image of imageFiles) {
          disposers.push(
            child.webServer.register({
              kind: 'exact',
              path: `${PREFIX}/skins/${skin.id}/images/${image}`,
              handler: (req, res) => {
                let asset
                try {
                  const fresh = current().skins.find((item) => item.id === skin.id)
                  if (!fresh) throw new Error(`skin ${skin.id} is no longer present`)
                  asset = imageAsset(fresh, image)
                } catch (error) {
                  warn(`${skin.id}/images/${image}: ${error instanceof Error ? error.message : String(error)}`)
                }
                if (asset === undefined) {
                  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('asset unavailable')
                  return
                }
                serveAsset(req, res, asset)
              },
            }),
          )
        }
        for (const sound of Array.isArray(skin.audio) ? skin.audio : []) {
          disposers.push(
            child.webServer.register({
              kind: 'exact',
              path: `${PREFIX}/skins/${skin.id}/audio/${sound}.mp3`,
              handler: (req, res) => {
                let asset
                try {
                  const fresh = current().skins.find((item) => item.id === skin.id)
                  if (!fresh) throw new Error(`skin ${skin.id} is no longer present`)
                  asset = resolveAsset(fresh.dir, path.join('lib', 'assets', `${sound}.mp3`))
                } catch (error) {
                  warn(`${skin.id}/audio/${sound}: ${error instanceof Error ? error.message : String(error)}`)
                }
                if (asset === undefined) {
                  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('asset unavailable')
                  return
                }
                serveAsset(req, res, asset)
              },
            }),
          )
        }
        for (const key of /** @type {const} */ (['boot', 'background', 'poster'])) {
          if (key === 'boot' && skin.boot.video === false) continue
          const file = key === 'poster' ? 'poster.jpg' : `${key}.mp4`
          disposers.push(
            child.webServer.register({
              kind: 'exact',
              path: `${PREFIX}/skins/${skin.id}/${file}`,
              handler: (req, res) => {
                let asset
                try {
                  const fresh = current().skins.find((item) => item.id === skin.id)
                  if (!fresh) throw new Error(`skin ${skin.id} is no longer present`)
                  asset = skinAsset(fresh, key)
                } catch (error) {
                  warn(`${skin.id}/${key}: ${error instanceof Error ? error.message : String(error)}`)
                }
                if (asset === undefined) {
                  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('asset unavailable')
                  return
                }
                serveAsset(req, res, asset)
              },
            }),
          )
        }
        const bgFile = String(skin.background.file || DEFAULT_GLOBAL.background.file)
        if (bgFile !== 'background.mp4' && bgFile !== 'poster.jpg' && bgFile !== 'boot.mp4') {
          disposers.push(
            child.webServer.register({
              kind: 'exact',
              path: `${PREFIX}/skins/${skin.id}/${bgFile}`,
              handler: (req, res) => {
                let asset
                try {
                  const fresh = current().skins.find((item) => item.id === skin.id)
                  if (!fresh) throw new Error(`skin ${skin.id} is no longer present`)
                  asset = skinAsset(fresh, 'background')
                } catch (error) {
                  warn(`${skin.id}/${bgFile}: ${error instanceof Error ? error.message : String(error)}`)
                }
                if (asset === undefined) {
                  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('asset unavailable')
                  return
                }
                serveAsset(req, res, asset)
              },
            }),
          )
        }
      }

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* already gone */
          }
        }
      }
    })
  })
}
