/**
 * Small, dependency-free helpers at the HTTP boundary.
 * Kept separate so the Range/MIME/path logic can be tested without a host.
 */
import path from 'node:path'

/** @typedef {{ start: number, end: number }} ParsedRange */

/**
 * Parse an HTTP Range header into a closed byte interval.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {ParsedRange | 'unsatisfiable' | null}
 */
export function parseRange(header, size) {
  if (header === undefined || header === null || header === '') return null
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (!Number.isFinite(size) || size <= 0) return 'unsatisfiable'
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

/**
 * @param {string} fileName
 * @returns {string}
 */
export function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(String(fileName)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a configured asset path without letting a relative path escape the
 * package. Absolute paths are allowed on purpose: the skin supports pointing
 * at your own film outside the package.
 * @param {string} packageRoot
 * @param {string} file
 * @returns {string}
 */
export function resolveAsset(packageRoot, file) {
  const raw = String(file)
  if (path.isAbsolute(raw)) return path.resolve(raw)
  const root = path.resolve(packageRoot)
  const target = path.resolve(root, raw)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`asset path escapes the package directory: ${raw}`)
  }
  return target
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function finiteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Clamp a dirty value to [min, max]; NaN falls back.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Serialize data for inline <script> text without allowing a `</script>` break.
 * @param {unknown} value
 * @returns {string}
 */
export function toInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/**
 * Shallow merge for the two config layers.
 * @param {Record<string, unknown>} base
 * @param {unknown} patch
 * @returns {Record<string, unknown>}
 */
export function mergeShallow(base, patch) {
  if (!isPlainObject(patch)) return base
  return { ...base, ...patch }
}
