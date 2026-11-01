/*
 * dsh-abyss-skin — browser runtime (multi-skin).
 *
 * Injected as text, not imported. It must never throw during evaluation.
 *
 * Flow:
 *   1. read the manifest of all skins from the injected config;
 *   2. pick the active skin (localStorage > manifest), apply its accent vars;
 *   3. play its boot film over the viewport;
 *   4. after handoff mount its looping background;
 *   5. keep a small switcher so skins can be changed live and previewed.
 *
 * The boot film is decoration, never a cage: every failure path is bounded and
 * click / Esc / Space skips immediately.
 */
;(function (global) {
  'use strict'

  var NS = '__DSH_ABYSS__'
  if (global.__DSH_ABYSS_STARTED__ === true) return
  var cfg = global[NS]
  if (cfg === null || typeof cfg !== 'object') return
  if (typeof global.document !== 'object' || global.document === null) return
  global.__DSH_ABYSS_STARTED__ = true

  var doc = global.document
  var PREFIX = '/dsh-abyss-skin'
  var STORAGE_KEY = 'dsh-abyss-active'
  var api = {
    version: typeof cfg.version === 'string' ? cfg.version : 'unknown',
    config: cfg,
    skins: [],
    active: null,
    state: {
      phase: 'idle',
      clipDone: false,
      appReady: false,
      entered: false,
      reason: null,
      failures: [],
      startedAt: 0,
    },
  }
  global[NS] = api

  var reduceMotion = false
  try {
    reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch (error) {
    reduceMotion = false
  }

  var boot = null
  var bg = null
  var bgStarting = false
  var bgScheduled = false
  var disabled = false
  var switcher = null
  var activeSkin = null
  var bootCfg = {}
  var bgCfg = {}
  var chrome = {}

  // ── tiny helpers ───────────────────────────────────────────────────────
  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function num(value, fallback, min, max) {
    var n = typeof value === 'number' ? value : Number(value)
    if (isNaN(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function now() {
    try {
      return global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now()
    } catch (error) {
      return Date.now()
    }
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text
  }

  function fail(label, error) {
    api.state.failures.push(label + ':' + ((error && error.message) || String(error)))
    try {
      if (global.console && global.console.warn) global.console.warn('[abyss-skin] ' + label, error)
    } catch (ignored) {
      /* noop */
    }
  }

  function channels(value) {
    var hex = String(value || '').replace('#', '').trim()
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    if (!/^[0-9a-f]{6}$/iu.test(hex)) return null
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  }

  function readStoredActive() {
    try {
      return global.localStorage ? global.localStorage.getItem(STORAGE_KEY) : null
    } catch (error) {
      return null
    }
  }

  function storeActive(id) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, id)
    } catch (error) {
      /* Web Storage is optional on custom protocols */
    }
  }

  // ── manifest ───────────────────────────────────────────────────────────
  function str(value, fallback) {
    return typeof value === 'string' && value.trim() ? value : fallback
  }

  function cleanPhases(value) {
    if (!Array.isArray(value)) return null
    var out = []
    for (var i = 0; i < value.length && out.length < 8; i += 1) {
      var raw = value[i]
      if (!isObject(raw)) continue
      out.push({
        id: str(raw.id, 'phase-' + out.length),
        kind: str(raw.kind, 'still'),
        chinese: str(raw.chinese, ''),
        rail: str(raw.rail, ''),
        english: str(raw.english, ''),
        note: str(raw.note, ''),
        prompt: str(raw.prompt, ''),
        action: str(raw.action, ''),
        duration: Math.min(12000, Math.max(0, Number(raw.duration) || 0)),
        auto: raw.auto !== false,
        interactive: raw.interactive === true,
        audio: str(raw.audio, ''),
      })
    }
    return out.length > 0 ? out : null
  }

  function cleanAudio(value) {
    if (!isObject(value)) return null
    var files = Array.isArray(value.files)
      ? value.files.filter(function (name) {
        return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*$/iu.test(name)
      }).slice(0, 32)
      : []
    return {
      enabled: value.enabled !== false && files.length > 0,
      base: str(value.base, ''),
      files: files,
    }
  }

  function cleanRite(value) {
    if (!isObject(value)) return null
    var profile = isObject(value.profile) ? value.profile : {}
    var clearance = Array.isArray(value.clearance)
      ? value.clearance.filter(function (item) { return typeof item === 'string' && item }).slice(0, 6)
      : []
    return {
      motto: str(value.motto, '自力更生 · 艰苦奋斗'),
      serial: str(value.serial, '1949 · 10 · 01'),
      stamp: str(value.stamp, '核验通过'),
      welcome: str(value.welcome, '山河无恙 · 星火相传'),
      kicker: str(value.kicker, 'VERMILION DAWN · 1949'),
      profile: {
        name: str(profile.name, '访问者'),
        serial: str(profile.serial, 'DSH-1949'),
        level: str(profile.level, '全权'),
        unit: str(profile.unit, '人民'),
      },
      clearance: clearance,
    }
  }

  function normalizeSkin(raw, index) {
    if (!isObject(raw)) return null
    var id = typeof raw.id === 'string' && raw.id ? raw.id : 'skin-' + index
    var boot = isObject(raw.boot) ? raw.boot : {}
    var background = isObject(raw.background) ? raw.background : {}
    var chrome = isObject(raw.chrome) ? raw.chrome : {}
    var bootVideo = boot.video !== false
    if (bootVideo && (typeof boot.src !== 'string' || !boot.src)) return null
    if (!bootVideo) boot.src = ''
    boot.video = bootVideo
    var images = Array.isArray(background.images)
      ? background.images.filter(function (src) { return typeof src === 'string' && src })
      : []
    if (!background.src && images.length) background.src = images[0]
    if (typeof background.src !== 'string' || !background.src) return null
    background.images = images
    return {
      id: id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id.toUpperCase(),
      tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
      description: typeof raw.description === 'string' ? raw.description : '',
      accent: typeof raw.accent === 'string' && raw.accent ? raw.accent : '#5fe8ff',
      accent2: typeof raw.accent2 === 'string' && raw.accent2 ? raw.accent2 : '#a78bfa',
      poster: typeof raw.poster === 'string' ? raw.poster : '',
      boot: boot,
      background: background,
      audio: cleanAudio(raw.audio),
      phases: cleanPhases(raw.phases),
      rite: cleanRite(raw.rite),
      chrome: {
        kicker: typeof chrome.kicker === 'string' && chrome.kicker ? chrome.kicker : 'DEEPSEEK HARNESS',
        title: typeof chrome.title === 'string' && chrome.title ? chrome.title : id.toUpperCase(),
        subtitle: typeof chrome.subtitle === 'string' ? chrome.subtitle : '',
        hud: chrome.hud !== false,
      },
    }
  }

  function normalizeManifest(raw) {
    var list = Array.isArray(raw.skins) ? raw.skins : []
    var skins = []
    for (var i = 0; i < list.length; i += 1) {
      var skin = normalizeSkin(list[i], i)
      if (skin && !skins.some(function (item) { return item.id === skin.id })) skins.push(skin)
    }
    // v1 compatibility: a single top-level boot/background pair.
    if (skins.length === 0 && isObject(raw.boot) && typeof raw.boot.src === 'string') {
      var legacy = normalizeSkin(
        {
          id: 'legacy',
          name: 'ABYSS PROTOCOL',
          accent: '#5fe8ff',
          accent2: '#a78bfa',
          boot: raw.boot,
          background: raw.background,
          chrome: raw.chrome,
        },
        0,
      )
      if (legacy) skins.push(legacy)
    }
    return skins
  }

  var skins = normalizeManifest(cfg)
  if (skins.length === 0) return
  api.skins = skins

  function findSkin(id) {
    for (var i = 0; i < skins.length; i += 1) if (skins[i].id === id) return skins[i]
    return null
  }

  function pickInitialSkin() {
    var query = ''
    try {
      query = String((global.location && global.location.search) || '')
    } catch (error) {
      query = ''
    }
    var match = /[?&]abyss_skin=([^&]+)/u.exec(query)
    if (match) {
      var fromUrl = findSkin(decodeURIComponent(match[1]))
      if (fromUrl) return fromUrl
    }
    var stored = findSkin(readStoredActive())
    if (stored) return stored
    var fromManifest = findSkin(typeof cfg.active === 'string' ? cfg.active : '')
    return fromManifest || skins[0]
  }

  activeSkin = pickInitialSkin()

  function applySkin(skin) {
    if (!skin) return
    activeSkin = skin
    bootCfg = skin.boot
    bgCfg = skin.background
    chrome = skin.chrome
    api.active = skin
    var root = doc.documentElement
    if (!root) return
    root.setAttribute('data-dsh-abyss-skin', skin.id)
    root.style.setProperty('--abyss-accent', skin.accent)
    root.style.setProperty('--abyss-accent2', skin.accent2)
    var rgb = channels(skin.accent)
    if (rgb) root.style.setProperty('--abyss-accent-rgb', rgb.join(', '))
    var rgb2 = channels(skin.accent2)
    if (rgb2) root.style.setProperty('--abyss-accent2-rgb', rgb2.join(', '))
  }

  applySkin(activeSkin)

  // ── boot audio: voice lines + interface sfx ───────────────────────────
  // The ceremony speaks. Each act owns one MP3 from `skins/<id>/lib/assets`
  // (served one route per file), plus a handful of interface sounds.
  //
  // Three rules keep sound decorative instead of load-bearing:
  //   * every clip is optional — a missing buffer degrades to a synth blip,
  //     a blocked AudioContext degrades to silence, nothing may stall an act;
  //   * voices are queued, never cancelled — clicking fast must not chop a
  //     line in half, the queue simply plays them in order;
  //   * while a line speaks the boot film's own music is ducked, so the voice
  //     sits on top of the march instead of fighting it.
  function createAudio(skin, bootCfg, hooks) {
    var voiceCfg = isObject(bootCfg.voice) ? bootCfg.voice : {}
    var sfxCfg = isObject(bootCfg.sfx) ? bootCfg.sfx : {}
    var packCfg = isObject(skin.audio) ? skin.audio : {}
    var files = Array.isArray(packCfg.files) ? packCfg.files : []
    var base = typeof packCfg.base === 'string' ? packCfg.base : ''
    var voiceOn = packCfg.enabled !== false && voiceCfg.enabled !== false && files.length > 0
    var sfxOn = sfxCfg.enabled !== false
    var voiceGain = num(voiceCfg.volume, 0.9, 0, 1)
    var sfxGain = num(sfxCfg.volume, 0.5, 0, 1)
    var cueOn = voiceCfg.cue !== false
    var leadMs = num(voiceCfg.lead, 240, 0, 1200)

    var AC = global.AudioContext || global.webkitAudioContext
    var ctx = null
    var master = null
    var buffers = {}
    var fetching = {}
    var sources = []
    var chain = Promise.resolve()
    var generation = 0
    var dead = false
    /* 诊断用：哪几段真的解码了、真的播完了。设置页/无头验证都读它。 */
    var stats = { context: 'idle', decoded: [], played: [], missing: [] }

    function clipUrl(name) {
      return base + encodeURIComponent(String(name)) + '.mp3'
    }

    function ensureCtx() {
      if (ctx !== null || !AC) return ctx
      try {
        ctx = new AC()
        stats.context = ctx.state
        master = ctx.createGain()
        master.gain.value = 1
        master.connect(ctx.destination)
        for (var i = 0; i < files.length; i += 1) load(files[i])
      } catch (error) {
        fail('audio-context', error)
        ctx = null
      }
      return ctx
    }

    function load(name) {
      if (!name || dead || files.indexOf(name) < 0) return Promise.resolve(null)
      if (buffers[name]) return Promise.resolve(buffers[name])
      if (fetching[name]) return fetching[name]
      var c = ensureCtx()
      if (!c || typeof global.fetch !== 'function') return Promise.resolve(null)
      fetching[name] = global
        .fetch(clipUrl(name))
        .then(function (res) {
          return res && res.ok ? res.arrayBuffer() : null
        })
        .then(function (data) {
          return data ? c.decodeAudioData(data) : null
        })
        .then(function (buf) {
          if (buf) {
            buffers[name] = buf
            stats.decoded.push(name)
            stats.context = ctx ? ctx.state : 'closed'
          } else {
            stats.missing.push(name)
          }
          return buf || null
        })
        .catch(function () {
          stats.missing.push(name)
          return null
        })
      return fetching[name]
    }

    function resume() {
      var c = ensureCtx()
      if (!c) return Promise.resolve(false)
      if (c.state === 'running') return Promise.resolve(true)
      try {
        var pending = c.resume()
        if (pending && typeof pending.then === 'function') {
          return pending.then(
            function () { return c.state === 'running' },
            function () { return false },
          )
        }
      } catch (error) { /* gesture policy; caller decides */ }
      return Promise.resolve(c.state === 'running')
    }

    /** Resolve true once the context is audible; also retries on the first gesture. */
    function readyWithin(ms) {
      var c = ensureCtx()
      if (!c) return Promise.resolve(false)
      if (c.state === 'running') return Promise.resolve(true)
      return new Promise(function (resolve) {
        var settled = false
        var watchdog = 0
        function cleanup() {
          try { doc.removeEventListener('pointerdown', onGesture, true) } catch (error) { /* noop */ }
          try { doc.removeEventListener('keydown', onGesture, true) } catch (error) { /* noop */ }
          try { global.clearTimeout(watchdog) } catch (error) { /* noop */ }
        }
        function finish(ok) {
          if (settled) return
          settled = true
          cleanup()
          resolve(ok)
        }
        function onGesture() {
          resume().then(function (ok) { if (ok) finish(true) })
        }
        doc.addEventListener('pointerdown', onGesture, true)
        doc.addEventListener('keydown', onGesture, true)
        watchdog = global.setTimeout(function () { finish(c.state === 'running') }, ms)
        onGesture()
      })
    }

    function dropSource(src) {
      for (var i = sources.length - 1; i >= 0; i -= 1) if (sources[i] === src) sources.splice(i, 1)
    }

    /** Play a decoded buffer and resolve with the milliseconds it occupied. */
    function playBuffer(buf, gain, done, name) {
      var c = ensureCtx()
      if (!c || !buf) { done(0); return }
      var ms = Math.round(buf.duration * 1000)
      var finished = false
      var guard = 0
      try {
        var src = c.createBufferSource()
        src.buffer = buf
        var amp = c.createGain()
        amp.gain.value = Math.max(0.0001, Math.min(1, gain))
        src.connect(amp)
        amp.connect(master)
        function finish() {
          if (finished) return
          finished = true
          try { global.clearTimeout(guard) } catch (error) { /* noop */ }
          dropSource(src)
          stats.played.push({ name: name || '?', ms: ms })
          if (stats.played.length > 300) stats.played.shift()
          if (hooks && hooks.duck) hooks.duck(false)
          done(ms)
        }
        src.onended = finish
        sources.push(src)
        if (hooks && hooks.duck) hooks.duck(true)
        src.start(0)
        /* onended is the normal exit, but a suspended context never fires it:
           the act must still be released on time. */
        guard = global.setTimeout(finish, ms + 1200)
      } catch (error) {
        if (hooks && hooks.duck) hooks.duck(false)
        done(0)
      }
    }

    function oneShot(name, gain) {
      var c = ensureCtx()
      if (!c || c.state !== 'running') return false
      var buf = buffers[name]
      if (!buf) { load(name); return false }
      try {
        var src = c.createBufferSource()
        src.buffer = buf
        var amp = c.createGain()
        amp.gain.value = Math.max(0.0001, Math.min(1, gain))
        src.connect(amp)
        amp.connect(master)
        src.start(0)
        sources.push(src)
        stats.played.push({ name: name, ms: Math.round(buf.duration * 1000) })
        if (stats.played.length > 300) stats.played.shift()
        src.onended = function () { dropSource(src) }
        return true
      } catch (error) {
        return false
      }
    }

    function tone(freq, dur, type, gain, delay, glideTo) {
      var c = ensureCtx()
      if (!c || c.state !== 'running' || !sfxOn) return
      try {
        var t0 = c.currentTime + (delay || 0)
        var osc = c.createOscillator()
        var amp = c.createGain()
        osc.type = type || 'sine'
        osc.frequency.setValueAtTime(freq, t0)
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur)
        amp.gain.setValueAtTime(0.0001, t0)
        amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, (gain || 0.03) * sfxGain * 2), t0 + Math.min(0.02, dur * 0.3))
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        osc.connect(amp)
        amp.connect(master)
        osc.start(t0)
        osc.stop(t0 + dur + 0.03)
      } catch (error) { /* a blip that fails is not a failure */ }
    }

    function cue() {
      if (!sfxOn) return
      tone(1046.5, 0.05, 'sine', 0.028)
      tone(1568, 0.06, 'sine', 0.02, 0.075)
    }

    /** Speak one line; resolves with the milliseconds it took (0 = silent). */
    function say(name, opts) {
      var o = opts || {}
      if (!voiceOn || !name || dead) return Promise.resolve(0)
      var useCue = o.cue === undefined ? cueOn : !!o.cue
      var lead = o.lead === undefined ? leadMs : num(o.lead, 0, 0, 2000)
      var token = generation
      function task() {
        if (dead || token !== generation) return 0
        return readyWithin(800).then(function (ok) {
          if (!ok || dead || token !== generation) return 0
          return load(name).then(function (buf) {
            if (!buf || dead || token !== generation) return 0
            if (useCue) cue()
            return new Promise(function (resolve) {
              global.setTimeout(function () {
                if (dead || token !== generation) { resolve(0); return }
                playBuffer(buf, voiceGain, resolve, name)
              }, useCue ? lead : 0)
            })
          })
        })
      }
      chain = chain.then(task, task).then(
        function (ms) { return typeof ms === 'number' ? ms : 0 },
        function () { return 0 },
      )
      return chain
    }

    function stopAll() {
      generation += 1
      chain = Promise.resolve()
      for (var i = sources.length - 1; i >= 0; i -= 1) {
        try { sources[i].onended = null; sources[i].stop(0) } catch (error) { /* already gone */ }
      }
      sources.length = 0
      if (hooks && hooks.duck) hooks.duck(false)
    }

    return {
      say: say,
      resume: resume,
      stats: stats,
      stop: stopAll,
      destroy: function () {
        dead = true
        stopAll()
        try { if (ctx && typeof ctx.close === 'function') ctx.close() } catch (error) { /* noop */ }
        ctx = null
        master = null
      },
      /* interface sounds: real clip first, synth blip only as the fallback */
      tick: function (gain) {
        var g = Math.min(1, (gain === undefined ? 0.45 : gain) * sfxGain * 2)
        if (!sfxOn) return
        if (!oneShot('sfx-tick', g)) tone(1760, 0.035, 'square', 0.022)
      },
      step: function () {
        if (!sfxOn) return
        if (!oneShot('sfx-tick', Math.min(1, 0.6 * sfxGain * 2))) {
          tone(880, 0.05, 'sine', 0.05)
          tone(1320, 0.07, 'sine', 0.028, 0.045)
        }
      },
      confirm: function () {
        if (!sfxOn) return
        if (!oneShot('sfx-tick', Math.min(1, 0.85 * sfxGain * 2))) {
          tone(660, 0.09, 'triangle', 0.07)
          tone(990, 0.17, 'triangle', 0.055, 0.085)
        }
      },
      tickRun: function () {
        if (!sfxOn) return
        oneShot('sfx-ticks-run', Math.min(1, 0.5 * sfxGain * 2))
      },
      chime: function () {
        if (!sfxOn) return
        tone(659.25, 0.9, 'sine', 0.055)
        tone(830.61, 0.9, 'sine', 0.04, 0.09)
        tone(987.77, 1.3, 'sine', 0.045, 0.18)
      },
      unlock: function () { resume() },
    }
  }

  // ── ceremonial boot (multi-phase skins) ───────────────────────────────
  // A full-screen "access dossier": star emblem on a rotating reticle, six
  // acts, a live meter and a red seal for the verdict. Owns its own sequencing;
  // startBoot only tells it when to start and what to do when it is over.
  function createRite(options) {
    var skin = options.skin
    var phases = options.phases
    var timer = options.timer
    var onFinish = options.onFinish
    var onSkip = options.onSkip
    var audio = options.audio || null
    var riteCfg = skin.rite || {}
    var total = phases.length
    var mottoText = typeof riteCfg.motto === 'string' && riteCfg.motto ? riteCfg.motto : '自力更生 · 艰苦奋斗'
    var serialText = typeof riteCfg.serial === 'string' && riteCfg.serial ? riteCfg.serial : '1949 · 10 · 01'
    var stampText = typeof riteCfg.stamp === 'string' && riteCfg.stamp ? riteCfg.stamp : '核验通过'
    var welcomeText = typeof riteCfg.welcome === 'string' && riteCfg.welcome ? riteCfg.welcome : '山河无恙 · 星火相传'
    var kickerText = typeof riteCfg.kicker === 'string' && riteCfg.kicker ? riteCfg.kicker : 'VERMILION DAWN · 1949'

    var root = el('div', 'abyss-rite')
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', '访问核验序列')

    root.appendChild(el('div', 'abyss-rite-aura'))
    root.appendChild(el('div', 'abyss-rite-rays'))
    var flags = el('div', 'abyss-rite-flags')
    for (var f = 0; f < 4; f += 1) flags.appendChild(el('i', 'abyss-rite-flag f' + f))
    root.appendChild(flags)
    root.appendChild(el('div', 'abyss-rite-grain'))

    var top = el('header', 'abyss-rite-top')
    var brand = el('div', 'abyss-rite-brand')
    brand.appendChild(el('i', 'abyss-rite-mark'))
    brand.appendChild(el('span', 'abyss-rite-brandname', skin.chrome.kicker))
    brand.appendChild(el('em', 'abyss-rite-badge', '红色精神'))
    top.appendChild(brand)
    var serial = el('div', 'abyss-rite-serial')
    serial.appendChild(el('span', null, '档案'))
    serial.appendChild(el('b', null, serialText))
    var clock = el('span', 'abyss-rite-clock', '00:00:00')
    serial.appendChild(clock)
    top.appendChild(serial)
    root.appendChild(top)

    root.appendChild(el('div', 'abyss-rite-motto', mottoText))

    var steps = el('ol', 'abyss-rite-steps')
    var stepItems = []
    for (var s = 0; s < phases.length; s += 1) {
      var li = el('li', 'abyss-rite-step')
      li.appendChild(el('i', 'abyss-rite-step-no', ('0' + (s + 1)).slice(-2)))
      li.appendChild(el('span', 'abyss-rite-step-label', phases[s].rail || phases[s].chinese))
      steps.appendChild(li)
      stepItems.push(li)
    }
    root.appendChild(steps)

    var stage = el('main', 'abyss-rite-stage')
    var reticle = el('div', 'abyss-rite-reticle')
    reticle.appendChild(el('i', 'abyss-rite-tickring'))
    reticle.appendChild(el('i', 'abyss-rite-star'))
    stage.appendChild(reticle)

    var kicker = el('div', 'abyss-rite-kicker', kickerText)
    var title = el('h1', 'abyss-rite-title')
    var sub = el('div', 'abyss-rite-sub')
    var subText = el('span', 'abyss-rite-subtext')
    sub.appendChild(subText)
    sub.appendChild(el('i', 'abyss-rite-caret'))
    var panel = el('div', 'abyss-rite-panel')
    var cta = el('div', 'abyss-rite-cta')
    var actionBtn = el('button', 'abyss-rite-action')
    actionBtn.type = 'button'
    var actionText = el('span', null, '申请访问')
    actionBtn.appendChild(actionText)
    actionBtn.appendChild(el('kbd', null, 'ENTER'))
    var autoHint = el('div', 'abyss-rite-autohint')
    autoHint.appendChild(el('i'))
    autoHint.appendChild(el('span', null, '自动推进'))
    cta.appendChild(actionBtn)
    cta.appendChild(autoHint)
    stage.appendChild(kicker)
    stage.appendChild(title)
    stage.appendChild(sub)
    stage.appendChild(panel)
    stage.appendChild(cta)
    root.appendChild(stage)

    var seal = el('div', 'abyss-rite-seal')
    seal.appendChild(el('span', 'abyss-rite-seal-star', '★'))
    seal.appendChild(el('b', null, stampText))
    seal.appendChild(el('small', null, '一九四九 · 北京'))
    root.appendChild(seal)

    var foot = el('footer', 'abyss-rite-foot')
    var status = el('div', 'abyss-rite-status')
    status.setAttribute('aria-live', 'polite')
    status.appendChild(el('i'))
    var statusText = el('span', null, '')
    status.appendChild(statusText)
    var meter = el('div', 'abyss-rite-meter')
    var meterFill = el('i', 'abyss-rite-meter-fill')
    meter.appendChild(meterFill)
    var meterTicks = el('div', 'abyss-rite-meter-ticks')
    for (var t = 1; t < total; t += 1) meterTicks.appendChild(el('i'))
    meter.appendChild(meterTicks)
    var pctWrap = el('div', 'abyss-rite-pct')
    var pctNum = el('b', null, '00')
    pctWrap.appendChild(pctNum)
    pctWrap.appendChild(el('small', null, '%'))
    var skip = el('button', 'abyss-rite-skip')
    skip.type = 'button'
    skip.appendChild(el('kbd', null, 'ESC'))
    skip.appendChild(el('span', null, '跳过开场'))
    var pctRow = el('div', 'abyss-rite-pctrow')
    pctRow.appendChild(pctWrap)
    pctRow.appendChild(skip)
    foot.appendChild(status)
    foot.appendChild(pctRow)
    foot.appendChild(meter)
    root.appendChild(foot)

    var flash = el('div', 'abyss-rite-flash')
    root.appendChild(flash)

    var index = -1
    var confirmed = false
    var finished = false
    var typeTimer = 0
    var pctToken = 0
    var phaseToken = 0
    var currentPct = 0

    var defaults = ['身份核验', '会话许可', '上下文读取', '工具调用']
    var clearance = Array.isArray(riteCfg.clearance) && riteCfg.clearance.length > 0 ? riteCfg.clearance : defaults
    var profile = riteCfg.profile || { name: '访问者', serial: 'DSH-1949', level: '全权', unit: '人民' }

    function setStatus(text, tone) {
      setText(statusText, text)
      root.setAttribute('data-tone', tone || 'idle')
    }

    function setMeter(value) {
      currentPct = Math.max(0, Math.min(100, value))
      meterFill.style.width = currentPct.toFixed(2) + '%'
      setText(pctNum, currentPct < 10 ? '0' + Math.round(currentPct) : String(Math.round(currentPct)))
    }

    function animatePct(target, ms) {
      var token = (pctToken += 1)
      var from = currentPct
      var startedAt = now()
      function step() {
        if (token !== pctToken) return
        var progress = ms <= 0 ? 1 : Math.min(1, (now() - startedAt) / ms)
        var eased = 1 - Math.pow(1 - progress, 3)
        setMeter(from + (target - from) * eased)
        if (progress < 1) timer(step, 48)
      }
      step()
    }

    function typeEnglish(text) {
      if (typeTimer) {
        try { global.clearInterval(typeTimer) } catch (error) { /* noop */ }
        typeTimer = 0
      }
      setText(subText, '')
      if (reduceMotion || !text) {
        setText(subText, text)
        return
      }
      var i = 0
      typeTimer = global.setInterval(function () {
        i += 1
        setText(subText, text.slice(0, i))
        /* one tick every other glyph: 45/s of the raw clip reads as noise */
        if (audio && i % 2 === 0 && text.charAt(i - 1) !== ' ') audio.tick(0.22)
        if (i >= text.length) {
          try { global.clearInterval(typeTimer) } catch (error) { /* noop */ }
          typeTimer = 0
        }
      }, 22)
    }

    function clearPanel() {
      while (panel.firstChild) panel.removeChild(panel.firstChild)
    }

    function fieldRow(label, value, order) {
      var row = el('div', 'abyss-rite-field')
      row.style.setProperty('--i', String(order))
      row.appendChild(el('dt', null, label))
      row.appendChild(el('dd', null, value))
      return row
    }

    function buildPanel(phase) {
      clearPanel()
      panel.className = 'abyss-rite-panel is-' + phase.kind

      if (phase.kind === 'permission') {
        var line = el('p', 'abyss-rite-line', '本机访问 · 需本人许可')
        panel.appendChild(line)
        var chips = el('div', 'abyss-rite-chips')
        var chipLabels = ['本机', '离线', '可撤销']
        for (var c = 0; c < chipLabels.length; c += 1) chips.appendChild(el('span', null, chipLabels[c]))
        panel.appendChild(chips)
        return
      }

      if (phase.kind === 'identity') {
        var card = el('div', 'abyss-rite-idcard')
        var photo = el('div', 'abyss-rite-idphoto')
        photo.appendChild(el('b', null, '★'))
        photo.appendChild(el('small', null, 'DSH'))
        card.appendChild(photo)
        var fields = el('dl', 'abyss-rite-fields')
        fields.appendChild(fieldRow('姓名', profile.name, 0))
        fields.appendChild(fieldRow('编号', profile.serial, 1))
        fields.appendChild(fieldRow('权限', profile.level, 2))
        fields.appendChild(fieldRow('归属', profile.unit, 3))
        card.appendChild(fields)
        panel.appendChild(card)
        return
      }

      if (phase.kind === 'request') {
        var signal = el('div', 'abyss-rite-signal')
        for (var b = 0; b < 5; b += 1) signal.appendChild(el('i'))
        panel.appendChild(signal)
        panel.appendChild(el('p', 'abyss-rite-line', '通道已接通 · 正在登记访问需求'))
        return
      }

      if (phase.kind === 'reading') {
        var list = el('ul', 'abyss-rite-clearance')
        for (var k = 0; k < clearance.length; k += 1) {
          var item = el('li')
          item.style.setProperty('--i', String(k))
          item.appendChild(el('i'))
          item.appendChild(el('span', null, clearance[k]))
          list.appendChild(item)
        }
        panel.appendChild(list)
        return
      }

      if (phase.kind === 'verified') {
        panel.classList.add('is-blank')
        return
      }

      if (phase.kind === 'welcome') {
        var stars = el('div', 'abyss-rite-fivestars')
        stars.appendChild(el('i', 'big'))
        for (var q = 0; q < 4; q += 1) stars.appendChild(el('i', 's' + q))
        panel.appendChild(stars)
        panel.appendChild(el('p', 'abyss-rite-welcome', welcomeText))
        return
      }

      panel.appendChild(el('p', 'abyss-rite-line', phase.note || ''))
    }

    function show(next) {
      if (finished) return
      if (next >= total) {
        finish()
        return
      }
      index = next
      confirmed = false
      var phase = phases[index]
      var token = (phaseToken += 1)

      root.setAttribute('data-phase', phase.id)
      root.setAttribute('data-kind', phase.kind)
      root.setAttribute('data-long', phase.chinese.length > 8 ? '1' : '0')
      root.removeAttribute('data-confirmed')
      root.removeAttribute('data-wait')

      for (var i = 0; i < stepItems.length; i += 1) {
        stepItems[i].setAttribute('data-state', i < index ? 'done' : i === index ? 'active' : 'todo')
      }

      setText(title, phase.chinese)
      title.classList.remove('is-enter')
      void title.offsetWidth
      title.classList.add('is-enter')
      typeEnglish(phase.english)
      buildPanel(phase)
      setStatus(phase.note || '正在执行核验序列', phase.interactive ? 'wait' : 'run')

      /* 这一幕的两粒声音先落位：推进音在本幕开头，台词的提示音在 say() 内部。 */
      if (audio) {
        audio.step()
        if (phase.kind === 'reading') audio.tickRun()
        if (phase.kind === 'welcome') audio.chime()
      }
      /* 终幕的和声钟要留出余韵，所以那一句不叠提示音，等 380ms 再开口。 */
      var spoke = audio
        ? audio.say(phase.audio, phase.kind === 'welcome' ? { cue: false, lead: 380 } : undefined)
        : Promise.resolve(0)

      actionBtn.style.display = phase.interactive ? '' : 'none'
      autoHint.style.display = phase.interactive ? 'none' : ''
      if (phase.interactive) {
        setText(actionText, phase.action || '继续')
        root.setAttribute('data-wait', '1')
        timer(function () {
          if (index === next && !confirmed && !finished && root.getAttribute('data-wait') === '1') {
            setStatus('等待超时 · 自动继续')
            confirm()
          }
        }, 12000)
      } else {
        /* 停留时间 = max(视觉基准, 实际播报时长 + 240ms 收尾)。
           台词长就多停，台词短也不干等；素材拿不到（resolved 0）时退回基准。 */
        var duration = phase.duration > 0 ? phase.duration : 2400
        spoke.then(function (spoken) {
          if (token !== phaseToken || finished) return
          var target = Math.max(duration, (spoken || 0) + 240)
          timer(function () {
            if (index === next && !confirmed && !finished) confirm()
          }, Math.max(0, target - (spoken || 0)))
        })
      }

      var target = ((index + 1) / total) * 100
      animatePct(phase.interactive ? (index / total) * 100 + 4 : target, phase.interactive ? 700 : (phase.duration || 2400))

      root.setAttribute('data-flash', '1')
      timer(function () { root.removeAttribute('data-flash') }, 130)
    }

    function confirm() {
      if (finished || confirmed) return
      confirmed = true
      root.removeAttribute('data-wait')
      root.setAttribute('data-confirmed', '1')
      if (audio) audio.confirm()
      setStatus(index >= total - 1 ? '序列完成' : '已确认 · 继续序列')
      animatePct(((index + 1) / total) * 100, 380)
      timer(function () {
        root.removeAttribute('data-confirmed')
        show(index + 1)
      }, 460)
    }

    function finish() {
      if (finished) return
      finished = true
      root.setAttribute('data-done', '1')
      root.setAttribute('data-kind', 'welcome')
      root.removeAttribute('data-wait')
      setStatus('核验完成 · 正在进入人民殿堂')
      animatePct(100, 620)
      timer(onFinish, 900)
    }

    function onKey(event) {
      if (finished) return
      var key = event.key
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
      var phase = phases[index]
      if (!phase || !phase.interactive) return
      event.preventDefault()
      event.stopPropagation()
      confirm()
    }

    function tickClock() {
      if (finished) return
      try {
        var d = new Date()
        var pad = function (n) { return (n < 10 ? '0' : '') + n }
        setText(clock, pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()))
      } catch (error) { /* noop */ }
      timer(tickClock, 1000)
    }
    tickClock()

    actionBtn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (phases[index] && phases[index].interactive) confirm()
    })
    skip.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (!finished) onSkip()
    })
    doc.addEventListener('keydown', onKey, true)

    return {
      root: root,
      start: function () { show(0) },
      destroy: function () {
        if (typeTimer) {
          try { global.clearInterval(typeTimer) } catch (error) { /* noop */ }
          typeTimer = 0
        }
        /* only skip / hand-off really stops a voice — advancing never does */
        if (audio) audio.stop()
        doc.removeEventListener('keydown', onKey, true)
        try { if (root.parentNode) root.parentNode.removeChild(root) } catch (error) { /* noop */ }
      },
    }
  }

  // ── boot overlay ───────────────────────────────────────────────────────
  function startBoot(skin, options) {
    if (!skin || disabled) return
    if (boot !== null) destroyBoot()
    if (skin.boot.enabled === false) {
      api.state.reason = 'boot-disabled'
      if (!(options && options.preview)) scheduleBackdrop(skin)
      return
    }
    var localBoot = skin.boot
    var localChrome = skin.chrome
    var isPreview = !!(options && options.preview)

    var fadeMs = num(localBoot.fadeMs, 1200, 200, 6000)
    var maxMs = num(localBoot.maxMs, 16000, 5000, 30000)
    var wantSound = localBoot.sound !== false
    var volume = num(localBoot.volume, 0.85, 0, 1)
    var hintIdle = typeof localBoot.hint === 'string' && localBoot.hint ? localBoot.hint : '正在接入协议…'
    var skipLabel = typeof localBoot.skipLabel === 'string' && localBoot.skipLabel ? localBoot.skipLabel : '点击跳过'

    // Check if this skin has multi-phase configuration
    var phases = Array.isArray(skin.phases) ? skin.phases : null
    var usePhasedBoot = phases && phases.length > 0
    var hasVideo = localBoot.video !== false && typeof localBoot.src === 'string' && localBoot.src !== ''

    var root = el('div', 'dsh-abyss-boot')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', 'DeepSeek Harness 启动动画')
    root.setAttribute('data-state', 'idle')
    root.setAttribute('data-skin', skin.id)
    root.setAttribute('data-hud', localChrome.hud === false ? 'off' : 'on')
    root.setAttribute('data-phases', usePhasedBoot ? 'on' : 'off')
    root.style.setProperty('--abyss-fade', fadeMs + 'ms')

    var video = el('video', 'dsh-abyss-boot-video')
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.autoplay = true
    video.preload = 'auto'
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('disablepictureinpicture', '')
    video.setAttribute('aria-hidden', 'true')

    var grade = el('div', 'dsh-abyss-boot-grade')
    var scan = el('div', 'dsh-abyss-boot-scan')
    var frame = el('div', 'dsh-abyss-frame')
    for (var c = 0; c < 4; c += 1) frame.appendChild(el('i', 'dsh-abyss-corner c' + c))
    var topline = el('div', 'dsh-abyss-topline')
    var brand = el('div', 'dsh-abyss-brand')
    brand.appendChild(el('i', 'dsh-abyss-brand-mark'))
    brand.appendChild(el('span', null, localChrome.kicker))
    var meta = el('div', 'dsh-abyss-meta')
    meta.appendChild(el('span', null, skin.name + ' / ' + api.version))
    var clock = el('span', 'dsh-abyss-clock', '00:00:00')
    meta.appendChild(clock)
    topline.appendChild(brand)
    topline.appendChild(meta)
    frame.appendChild(topline)

    var hero = el('div', 'dsh-abyss-hero')
    var kicker = el('div', 'dsh-abyss-kicker')
    kicker.appendChild(el('i', 'dsh-abyss-kicker-line'))
    kicker.appendChild(el('span', null, localChrome.kicker))
    var title = el('div', 'dsh-abyss-title')
    var words = String(localChrome.title || skin.name).split(/\s+/u)
    title.appendChild(el('span', 'dsh-abyss-title-solid', words[0] || skin.name))
    title.appendChild(el('span', 'dsh-abyss-title-outline', words.slice(1).join(' ') || 'PROTOCOL'))
    var subtitle = el('div', 'dsh-abyss-subtitle', localChrome.subtitle)
    hero.appendChild(kicker)
    hero.appendChild(title)
    hero.appendChild(subtitle)

    // Phased skins get a dedicated ceremony layer instead of the HUD.
    // (Built after `timer` exists so the sequence shares the boot cleanup.)
    var rite = null
    // Voice lines + interface sounds for the ceremony (null on plain skins).
    var audio = null

    var readout = el('div', 'dsh-abyss-readout')
    var log = el('div', 'dsh-abyss-log')
    readout.appendChild(log)
    var pctWrap = el('div', 'dsh-abyss-pct')
    var pctNum = el('span', null, '00')
    pctWrap.appendChild(pctNum)
    pctWrap.appendChild(el('small', null, '%'))
    readout.appendChild(pctWrap)

    var progress = el('div', 'dsh-abyss-progress')
    var fill = el('div', 'dsh-abyss-progress-fill')
    progress.appendChild(fill)
    var progressMeta = el('div', 'dsh-abyss-progress-meta')
    var hint = el('div', 'dsh-abyss-hint', hintIdle)
    var phase = el('div', 'dsh-abyss-phase', 'BOOT SEQUENCE')
    progressMeta.appendChild(hint)
    progressMeta.appendChild(phase)

    var skip = el('div', 'dsh-abyss-skip')
    skip.appendChild(el('span', 'dsh-abyss-skip-key', 'ESC'))
    skip.appendChild(el('span', null, skipLabel))

    var soundButton = el('button', 'dsh-abyss-sound')
    soundButton.type = 'button'
    soundButton.setAttribute('data-visible', '0')
    soundButton.appendChild(el('span', null, '♪'))
    soundButton.appendChild(el('span', null, '开启声音'))

    root.appendChild(video)
    root.appendChild(grade)
    root.appendChild(scan)
    root.appendChild(frame)
    root.appendChild(hero)
    root.appendChild(readout)
    root.appendChild(progress)
    root.appendChild(progressMeta)
    root.appendChild(skip)
    root.appendChild(soundButton)

    if (usePhasedBoot) {
      hero.style.display = 'none'
      frame.style.display = 'none'
      readout.style.display = 'none'
      progress.style.display = 'none'
      progressMeta.style.display = 'none'
      skip.style.display = 'none'
      root.setAttribute('data-rite', 'on')
    }

    if (!doc.body) throw new Error('document.body is unavailable')
    doc.body.appendChild(root)

    var state = {
      leaving: false,
      clipDone: false,
      appReady: false,
      playing: false,
      audioBlocked: false,
      failure: false,
      timers: [],
      raf: 0,
      retry: false,
      startedAt: now(),
    }
    api.state = {
      phase: 'idle',
      clipDone: false,
      appReady: false,
      entered: false,
      reason: null,
      failures: [],
      startedAt: state.startedAt,
    }
    boot = { root: root, video: video, state: state, skin: skin }
    root.setAttribute('data-preview', isPreview ? '1' : '0')

    function timer(fn, ms) {
      var id = global.setTimeout(fn, ms)
      state.timers.push(id)
      return id
    }

    function clearTimers() {
      for (var i = 0; i < state.timers.length; i += 1) global.clearTimeout(state.timers[i])
      state.timers.length = 0
      if (state.raf) {
        try { global.cancelAnimationFrame(state.raf) } catch (error) { /* noop */ }
        state.raf = 0
      }
    }

    function skipFade() {
      return num(localBoot.skipFadeMs, 280, 80, 2000)
    }

    function setHint(text) { setText(hint, text) }
    function setPhase(text) { setText(phase, text) }

    function setPct(pct) {
      var value = Math.max(0, Math.min(100, Math.round(pct)))
      setText(pctNum, value < 10 ? '0' + value : String(value))
      fill.style.width = value + '%'
      root.setAttribute('data-pct', String(value))
    }

    if (usePhasedBoot) {
      audio = createAudio(skin, localBoot, {
        /* 台词开口时把进行曲压到三成，念完再抬回来 —— 旁白压乐，不是两轨打架 */
        duck: function (active) { duckMusic(active) },
      })
      api.audioStats = audio.stats
      rite = createRite({
        skin: skin,
        phases: phases,
        timer: timer,
        audio: audio,
        onSkip: function () { enter(skipFade(), 'manual') },
        onFinish: function () {
          state.clipDone = true
          api.state.clipDone = true
          setPct(100)
          enter(fadeMs, 'rite')
        },
      })
      root.appendChild(rite.root)
      rite.start()
    }

    function safePlay() {
      try {
        var p = video.play()
        if (p && typeof p.then === 'function') {
          p.then(function () { state.playing = true }, function () { /* poster/gradient stays */ })
        }
      } catch (error) {
        /* autoplay policy / decode; not fatal */
      }
    }

    function playWithSound() {
      if (!wantSound) {
        video.muted = true
        video.volume = 0
        safePlay()
        return
      }
      video.muted = false
      video.volume = volume
      var result = video.play()
      if (result && typeof result.then === 'function') {
        result.then(
          function () {
            state.playing = true
            state.audioBlocked = false
            soundButton.setAttribute('data-visible', '0')
            root.removeAttribute('data-muted')
          },
          function () {
            state.audioBlocked = true
            video.muted = true
            video.volume = 0
            soundButton.setAttribute('data-visible', '1')
            root.setAttribute('data-muted', '1')
            setHint('点击左下角开启声音 · 或点击画面跳过')
            safePlay()
          },
        )
      } else {
        state.playing = true
      }
    }

    var duckTimer = 0
    /** Ramp the boot film's own score down under a spoken line, then back up. */
    function duckMusic(active) {
      if (duckTimer) {
        try { global.clearInterval(duckTimer) } catch (error) { /* noop */ }
        duckTimer = 0
      }
      if (!wantSound || state.audioBlocked || video.muted) return
      var from = video.volume
      var to = active ? volume * 0.3 : volume
      if (Math.abs(from - to) < 0.02) return
      var steps = 12
      var done = 0
      duckTimer = global.setInterval(function () {
        done += 1
        try { video.volume = Math.max(0, Math.min(1, from + (to - from) * (done / steps))) } catch (error) { /* noop */ }
        if (done >= steps) {
          try { global.clearInterval(duckTimer) } catch (error) { /* noop */ }
          duckTimer = 0
        }
      }, 30)
    }

    function fadeAudio(ms) {
      if (video.muted) return
      var from = video.volume
      var frames = Math.max(1, Math.round(ms / 16))
      var done = 0
      function step() {
        if (boot === null || boot.video !== video) return
        done += 1
        try { video.volume = Math.max(0, from * (1 - done / frames)) } catch (error) { return }
        if (done < frames) requestFrame(step)
      }
      requestFrame(step)
    }

    function requestFrame(fn) {
      if (typeof global.requestAnimationFrame === 'function') return global.requestAnimationFrame(fn)
      return global.setTimeout(fn, 16)
    }

    function onKeydown(event) {
      if (state.leaving) return
      var key = event.key
      if (key !== 'Escape' && key !== ' ' && key !== 'Enter' && key !== 'Spacebar') return
      // In a ceremony only Esc skips; Enter/Space belong to the rite itself.
      if (usePhasedBoot && key !== 'Escape') return
      event.preventDefault()
      enter(skipFade(), 'manual')
    }

    function enter(span, reason) {
      if (state.leaving) return
      state.leaving = true
      api.state.phase = 'leaving'
      api.state.entered = true
      api.state.reason = reason
      var ms = Math.round(num(span, fadeMs, 80, 6000))
      root.style.setProperty('--abyss-fade', ms + 'ms')
      root.setAttribute('data-state', 'leaving')
      fadeAudio(ms)
      clearTimers()
      if (rite !== null) {
        try { rite.destroy() } catch (error) { /* already gone */ }
        rite = null
      }
      if (audio !== null) {
        try { audio.destroy() } catch (error) { /* already gone */ }
        audio = null
      }
      if (duckTimer) {
        try { global.clearInterval(duckTimer) } catch (error) { /* noop */ }
        duckTimer = 0
      }
      doc.removeEventListener('keydown', onKeydown, true)
      try {
        if (global.console && global.console.info) {
          global.console.info(
            '[abyss-skin] boot leaving: skin=' + skin.id + ' reason=' + reason +
              ' fade=' + ms + 'ms' +
              ' t=' + (isFinite(video.currentTime) ? video.currentTime.toFixed(2) : '?') +
              ' dur=' + (isFinite(video.duration) ? video.duration.toFixed(2) : '?'),
          )
        }
      } catch (error) { /* diagnostics only */ }
      timer(function () {
        try { if (root.parentNode) root.parentNode.removeChild(root) } catch (error) { /* already gone */ }
        try { video.pause(); video.removeAttribute('src'); video.load() } catch (error) { /* noop */ }
        if (boot !== null && boot.root === root) boot = null
        api.state.phase = 'gone'
        global[NS + '_BOOT_DONE'] = true
        if (!isPreview) scheduleBackdrop(skin)
      }, ms + 120)
    }

    function maybeEnter() {
      if (state.leaving) return
      if (!state.clipDone) return
      if (!state.appReady) {
        setHint('界面就绪后自动进入')
        setPhase('AWAITING SHELL')
        return
      }
      setPct(100)
      enter(fadeMs, 'complete')
    }

    function markClipDone(reason) {
      if (state.clipDone) return
      state.clipDone = true
      api.state.clipDone = true
      setPhase('SEQUENCE COMPLETE')
      if (reason !== 'ended' && reason !== 'no-video') setHint('启动动画不可用 · 正在进入')
      maybeEnter()
    }

    function onVideoError() {
      if (state.leaving) return
      if (!state.retry) {
        state.retry = true
        api.state.failures.push('video-retry')
        try {
          video.src = localBoot.src + (localBoot.src.indexOf('?') >= 0 ? '&' : '?') + 'retry=1'
          video.load()
          playWithSound()
          return
        } catch (error) { /* fall through */ }
      }
      state.failure = true
      api.state.failures.push('video-failed')
      root.setAttribute('data-video', 'failed')
      if (usePhasedBoot) return
      markClipDone('error')
    }

    function detectAppReady() {
      var container = doc.getElementById('root')
      if (container === null || container === undefined) return false
      var children = container.children
      if (!children || children.length === 0) return false
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i]
        if (child && typeof child.hasAttribute === 'function' && !child.hasAttribute('data-dsh-boot')) return true
      }
      return false
    }

    function markAppReady(why) {
      if (state.appReady) return
      state.appReady = true
      api.state.appReady = true
      setPct(96)
      setPhase('SHELL READY')
      if (!state.failure) setHint('正在进入 · 点击画面可跳过')
      maybeEnter()
    }

    var observer = null
    try {
      if (typeof global.MutationObserver === 'function') {
        observer = new global.MutationObserver(function () {
          if (detectAppReady()) markAppReady('mutation')
        })
        var container = doc.getElementById('root')
        if (container) observer.observe(container, { childList: true })
      }
    } catch (error) { observer = null }

    var poll = function () {
      if (state.leaving) return
      if (detectAppReady()) { markAppReady('poll'); return }
      timer(poll, 120)
    }
    timer(poll, 120)

    var LOG = ['LINK ESTABLISHED', 'NEURAL MESH SYNC', 'CONTEXT LATTICE READY', 'ABYSS CORE ONLINE']
    var logIndex = 0
    function pushLog() {
      if (state.leaving) return
      var line = el('div', 'dsh-abyss-log-line')
      line.appendChild(el('i'))
      line.appendChild(el('span', null, LOG[logIndex % LOG.length]))
      logIndex += 1
      log.appendChild(line)
      while (log.children.length > 3) log.removeChild(log.firstChild)
      timer(pushLog, 2100)
    }
    timer(pushLog, 1150)

    function tickClock() {
      if (state.leaving) return
      try {
        var d = new Date()
        var pad = function (n) { return (n < 10 ? '0' : '') + n }
        setText(clock, pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()))
      } catch (error) { /* noop */ }
      timer(tickClock, 1000)
    }
    tickClock()

    function progressLoop() {
      if (state.leaving) return
      var pct = null
      try {
        var spinner = doc.querySelector('[data-dsh-boot-spinner]')
        if (spinner && spinner.style) {
          var raw = parseFloat(spinner.style.getPropertyValue('--dsh-boot-arc'))
          if (isFinite(raw)) pct = Math.min(100, Math.max(0, ((raw - 72) / 216) * 100))
        }
      } catch (error) { pct = null }
      if (pct === null) {
        var elapsed = now() - state.startedAt
        pct = Math.min(94, (elapsed / (maxMs * 0.62)) * 94)
      }
      if (state.appReady && state.clipDone) pct = 100
      else if (state.appReady) pct = Math.min(96, pct)
      setPct(pct)
      state.raf = requestFrame(progressLoop)
    }
    if (!usePhasedBoot) progressLoop()

    if (hasVideo) {
      video.addEventListener('loadeddata', function () { root.setAttribute('data-video', 'ready') })
      video.addEventListener('playing', function () {
        state.playing = true
        root.setAttribute('data-video', 'playing')
        if (!state.audioBlocked && !usePhasedBoot) setHint('协议已接通 · 点击可跳过')
      })
      video.addEventListener('ended', function () {
        // The ceremony owns its own clock; a finished film must not skip it.
        if (!usePhasedBoot) markClipDone('ended')
      })
      video.addEventListener('error', onVideoError)
      video.src = localBoot.src
      video.load()
      playWithSound()
    } else {
      // Video-less boot: the six-act rite (or the CSS shell) is the whole
      // visual. Do not touch video.src, so no 404 and no autoplay work.
      root.setAttribute('data-video', 'off')
      if (!usePhasedBoot) markClipDone('no-video')
    }

    soundButton.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (state.leaving) return
      try {
        video.muted = false
        video.volume = volume
      } catch (error) { return }
      /* 同一手势也要唤醒 WebAudio：进行曲开了，台词与音效才跟着出来 */
      if (audio !== null) {
        try { audio.unlock() } catch (error) { /* noop */ }
      }
      if (!hasVideo) {
        state.audioBlocked = false
        soundButton.setAttribute('data-visible', '0')
        root.removeAttribute('data-muted')
        setHint('声音已开启 · 点击画面跳过')
        return
      }
      var p = video.play()
      if (p && typeof p.then === 'function') {
        p.then(
          function () {
            state.audioBlocked = false
            soundButton.setAttribute('data-visible', '0')
            root.removeAttribute('data-muted')
            setHint('声音已开启 · 点击画面跳过')
          },
          function () { setHint('系统拒绝了声音播放 · 点击画面跳过') },
        )
      }
    })

    function skipFromEvent(event) {
      if (state.leaving) return
      if (event && event.target && soundButton.contains && soundButton.contains(event.target)) return
      enter(skipFade(), 'manual')
    }
    if (!usePhasedBoot) root.addEventListener('click', skipFromEvent)
    doc.addEventListener('keydown', onKeydown, true)

    var hardCapMs = usePhasedBoot ? maxMs + 30000 : maxMs
    timer(function () {
      if (state.leaving) return
      setHint('启动较慢 · 正在进入')
      setPhase('TIMEOUT')
      enter(fadeMs, 'timeout')
    }, hardCapMs)

    if (reduceMotion && !usePhasedBoot) {
      timer(function () {
        if (!state.leaving) enter(fadeMs, 'reduced-motion')
      }, 2600)
    }

    // expose a cleanup hook for live skin switching / replay
    boot.cleanup = function () {
      state.leaving = true
      clearTimers()
      if (rite !== null) {
        try { rite.destroy() } catch (error) { /* noop */ }
        rite = null
      }
      if (audio !== null) {
        try { audio.destroy() } catch (error) { /* noop */ }
        audio = null
      }
      if (duckTimer) {
        try { global.clearInterval(duckTimer) } catch (error) { /* noop */ }
        duckTimer = 0
      }
      doc.removeEventListener('keydown', onKeydown, true)
      root.removeEventListener('click', skipFromEvent)
      try { if (root.parentNode) root.parentNode.removeChild(root) } catch (error) { /* noop */ }
      try { video.pause(); video.removeAttribute('src'); video.load() } catch (error) { /* noop */ }
      if (boot !== null && boot.root === root) boot = null
    }
  }

  function destroyBoot() {
    if (boot === null) return
    try { boot.cleanup() } catch (error) { fail('boot-cleanup', error) }
    boot = null
  }

  // ── background ─────────────────────────────────────────────────────────
  function setBackdropVars(skin) {
    var root = doc.documentElement
    root.setAttribute('data-dsh-abyss', 'on')
    root.setAttribute('data-dsh-abyss-skin', skin.id)
    root.style.setProperty('--abyss-surface', String(num(skin.background.surface, 0.26, 0, 1)))
    root.style.setProperty('--abyss-sidebar', String(num(skin.background.sidebar, 0.42, 0, 1)))
    root.style.setProperty('--abyss-veil', String(num(skin.background.veil, 0.18, 0, 0.92)))
    root.style.setProperty('--abyss-surface-light', String(Math.min(1, num(skin.background.surface, 0.26, 0, 1) + 0.48)))
  }

  function createBgVideo(skin) {
    var video = el('video', 'dsh-abyss-bg-video')
    video.muted = true
    video.loop = true
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('disablepictureinpicture', '')
    video.setAttribute('aria-hidden', 'true')
    video.setAttribute('data-shown', '0')
    try { video.playbackRate = num(skin.background.playbackRate, 0.82, 0.25, 2) } catch (error) { /* noop */ }
    video.addEventListener('loadedmetadata', function () {
      try { video.playbackRate = num(skin.background.playbackRate, 0.82, 0.25, 2) } catch (error) { /* noop */ }
    })
    video.addEventListener('playing', function () {
      video.setAttribute('data-shown', '1')
      if (bg && bg.root) bg.root.setAttribute('data-video', 'playing')
    })
    video.addEventListener('error', function () {
      if (bg && bg.root) {
        bg.root.setAttribute('data-video', 'failed')
        doc.documentElement.setAttribute('data-dsh-abyss-fallback', 'on')
      }
    })
    video.src = skin.background.src
    video.load()
    var p = video.play()
    if (p && typeof p.then === 'function') p.catch(function () { /* first frame is enough */ })
    return video
  }

  function scheduleBackdrop(skin) {
    if (disabled || bg !== null || bgStarting || bgScheduled) return
    if (!skin || skin.background.enabled === false) return
    bgScheduled = true
    var wait = num(skin.background.delayMs, 600, 0, 10000)
    global.setTimeout(function () {
      bgScheduled = false
      startBackdrop(skin)
    }, wait)
  }

  function isGallery(skin) {
    return !!(skin && Array.isArray(skin.background.images) && skin.background.images.length > 0)
  }

  // Older manifests only carry `src`; the extension keeps them working.
  function isImageBackdrop(skin) {
    if (!skin || !skin.background) return false
    if (skin.background.kind === 'image') return true
    return /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/iu.test(String(skin.background.src || ''))
  }

  function destroyBackdrop() {
    if (bg === null) return
    if (bg.timer) {
      try { global.clearTimeout(bg.timer) } catch (error) { /* noop */ }
      bg.timer = null
    }
    if (bg.visibilityHandler) {
      try { doc.removeEventListener('visibilitychange', bg.visibilityHandler) } catch (error) { /* noop */ }
      bg.visibilityHandler = null
    }
    try {
      if (bg.video) {
        bg.video.pause()
        bg.video.removeAttribute('src')
        bg.video.load()
      }
    } catch (error) { /* noop */ }
    try {
      if (bg.root.parentNode) bg.root.parentNode.removeChild(bg.root)
    } catch (error) { /* noop */ }
    bg = null
  }

  function showGallery(index) {
    if (!bg || bg.kind !== 'gallery' || bg.frames.length === 0) return
    bg.index = ((index % bg.frames.length) + bg.frames.length) % bg.frames.length
    for (var i = 0; i < bg.frames.length; i += 1) {
      bg.frames[i].setAttribute('data-shown', i === bg.index ? '1' : '0')
      if (bg.images[i]) bg.images[i].setAttribute('data-shown', i === bg.index ? '1' : '0')
    }
  }

  function scheduleGallery() {
    if (!bg || bg.kind !== 'gallery' || bg.paused || disabled) return
    if (bg.timer) {
      try { global.clearTimeout(bg.timer) } catch (error) { /* noop */ }
      bg.timer = null
    }
    bg.timer = global.setTimeout(function () {
      if (!bg || bg.kind !== 'gallery' || bg.paused || disabled) return
      if (doc.hidden) {
        scheduleGallery()
        return
      }
      showGallery(bg.index + 1)
      scheduleGallery()
    }, bg.intervalMs)
  }

  function startGalleryBackdrop(skin) {
    if (disabled || bg !== null || bgStarting) return
    bgStarting = true
    try {
      setBackdropVars(skin)
      var root = el('div', 'dsh-abyss-bg')
      root.id = 'dsh-abyss-bg'
      root.setAttribute('aria-hidden', 'true')
      var gallery = el('div', 'dsh-abyss-bg-gallery')
      var images = []
      var frames = []
      skin.background.images.forEach(function (src) {
        var item = el('div', 'dsh-abyss-gallery-item')
        item.setAttribute('data-shown', '0')
        var blur = el('img', 'dsh-abyss-bg-blur')
        blur.alt = ''
        blur.decoding = 'async'
        blur.loading = 'eager'
        blur.setAttribute('aria-hidden', 'true')
        blur.src = src
        var img = el('img', 'dsh-abyss-bg-image')
        img.alt = ''
        img.decoding = 'async'
        img.loading = 'eager'
        img.setAttribute('data-shown', '0')
        img.src = src
        img.addEventListener('load', function () {
          if (bg && bg.kind === 'gallery' && bg.images[bg.index] === img) {
            img.setAttribute('data-shown', '1')
            bg.frames[bg.index].setAttribute('data-shown', '1')
          }
        })
        item.appendChild(blur)
        item.appendChild(img)
        gallery.appendChild(item)
        images.push(img)
        frames.push(item)
      })
      var veil = el('div', 'dsh-abyss-bg-veil')
      veil.id = 'dsh-abyss-bg-veil'
      var grain = el('div', 'dsh-abyss-bg-grain')
      grain.id = 'dsh-abyss-bg-grain'
      var glow = el('div', 'dsh-abyss-bg-glow')
      glow.id = 'dsh-abyss-bg-glow'
      root.appendChild(gallery)
      root.appendChild(veil)
      root.appendChild(grain)
      root.appendChild(glow)
      if (!doc.body) throw new Error('document.body is unavailable')
      doc.body.appendChild(root)
      bg = {
        root: root,
        kind: 'gallery',
        gallery: gallery,
        images: images,
        frames: frames,
        index: 0,
        intervalMs: num(skin.background.intervalMs, 15000, 3000, 120000),
        skinId: skin.id,
        paused: false,
        timer: null,
      }
      showGallery(0)
      var galleryVisibility = function () {
        if (!bg || bg.kind !== 'gallery') return
        if (doc.hidden) {
          if (bg.timer) {
            try { global.clearTimeout(bg.timer) } catch (error) { /* noop */ }
            bg.timer = null
          }
        } else if (!bg.paused && bg.frames.length > 1) {
          scheduleGallery()
        }
      }
      bg.visibilityHandler = galleryVisibility
      doc.addEventListener('visibilitychange', galleryVisibility)
      if (bg.frames.length > 1) scheduleGallery()
    } catch (error) {
      fail('gallery', error)
    } finally {
      bgStarting = false
    }
  }

  function startImageBackdrop(skin) {
    if (disabled || bg !== null || bgStarting) return
    bgStarting = true
    try {
      setBackdropVars(skin)
      var root = el('div', 'dsh-abyss-bg')
      root.id = 'dsh-abyss-bg'
      root.setAttribute('aria-hidden', 'true')
      root.setAttribute('data-image', '1')
      var item = el('div', 'dsh-abyss-gallery-item')
      item.setAttribute('data-shown', '0')
      var blur = el('img', 'dsh-abyss-bg-blur')
      blur.alt = ''
      blur.decoding = 'async'
      blur.loading = 'eager'
      blur.setAttribute('aria-hidden', 'true')
      blur.src = skin.background.src
      var image = el('img', 'dsh-abyss-bg-image')
      image.alt = ''
      image.decoding = 'async'
      image.loading = 'eager'
      image.setAttribute('data-shown', '0')
      image.src = skin.background.src
      var reveal = function () {
        if (!bg || bg.kind !== 'image' || bg.skinId !== skin.id) return
        item.setAttribute('data-shown', '1')
        image.setAttribute('data-shown', '1')
      }
      if (image.complete && image.naturalWidth > 0) reveal()
      else image.addEventListener('load', reveal)
      image.addEventListener('error', function () {
        if (bg && bg.kind === 'image') bg.root.setAttribute('data-failed', '1')
      })
      item.appendChild(blur)
      item.appendChild(image)
      var veil = el('div', 'dsh-abyss-bg-veil')
      veil.id = 'dsh-abyss-bg-veil'
      var grain = el('div', 'dsh-abyss-bg-grain')
      grain.id = 'dsh-abyss-bg-grain'
      var glow = el('div', 'dsh-abyss-bg-glow')
      glow.id = 'dsh-abyss-bg-glow'
      root.appendChild(item)
      root.appendChild(veil)
      root.appendChild(grain)
      root.appendChild(glow)
      if (!doc.body) throw new Error('document.body is unavailable')
      doc.body.appendChild(root)
      bg = { root: root, kind: 'image', image: image, skinId: skin.id, paused: false, visibilityHandler: null }
    } catch (error) {
      fail('image-backdrop', error)
    } finally {
      bgStarting = false
    }
  }

  function startBackdrop(skin) {
    if (disabled || bg !== null || bgStarting) return
    if (!skin || skin.background.enabled === false) return
    if (isGallery(skin)) {
      startGalleryBackdrop(skin)
      return
    }
    if (isImageBackdrop(skin)) {
      startImageBackdrop(skin)
      return
    }
    if (!skin.background.src) return
    bgStarting = true
    try {
      setBackdropVars(skin)
      var root = el('div', 'dsh-abyss-bg')
      root.id = 'dsh-abyss-bg'
      root.setAttribute('aria-hidden', 'true')
      var video = createBgVideo(skin)
      var veil = el('div', 'dsh-abyss-bg-veil')
      veil.id = 'dsh-abyss-bg-veil'
      var grain = el('div', 'dsh-abyss-bg-grain')
      grain.id = 'dsh-abyss-bg-grain'
      var glow = el('div', 'dsh-abyss-bg-glow')
      glow.id = 'dsh-abyss-bg-glow'
      root.appendChild(video)
      root.appendChild(veil)
      root.appendChild(grain)
      root.appendChild(glow)
      if (!doc.body) throw new Error('document.body is unavailable')
      doc.body.appendChild(root)
      bg = { root: root, video: video, skinId: skin.id, paused: false, visibilityHandler: null }
      var videoVisibility = function () {
        if (!bg || bg.kind === 'gallery') return
        if (doc.hidden) {
          try { bg.video.pause() } catch (error) { /* noop */ }
        } else if (!bg.paused && !reduceMotion) {
          try {
            var q = bg.video.play()
            if (q && typeof q.then === 'function') q.catch(function () {})
          } catch (error) { /* noop */ }
        }
      }
      bg.visibilityHandler = videoVisibility
      doc.addEventListener('visibilitychange', videoVisibility)
    } catch (error) {
      fail('backdrop', error)
    } finally {
      bgStarting = false
    }
  }

  function swapBackdrop(skin) {
    if (disabled || !skin || skin.background.enabled === false) return
    if (isGallery(skin)) {
      if (bg && bg.kind === 'gallery' && bg.skinId === skin.id) return
      setBackdropVars(skin)
      destroyBackdrop()
      startGalleryBackdrop(skin)
      return
    }
    if (!skin.background.src) return
    if (isImageBackdrop(skin)) {
      if (bg && bg.kind === 'image' && bg.skinId === skin.id) return
      setBackdropVars(skin)
      destroyBackdrop()
      startImageBackdrop(skin)
      return
    }
    if (bg === null) {
      startBackdrop(skin)
      return
    }
    if (bg.kind !== 'video') {
      setBackdropVars(skin)
      destroyBackdrop()
      startBackdrop(skin)
      return
    }
    if (bg.skinId === skin.id) return
    setBackdropVars(skin)
    bg.skinId = skin.id
    var old = bg.video
    var next = createBgVideo(skin)
    next.setAttribute('data-shown', '0')
    bg.root.insertBefore(next, old)
    bg.video = next
    var swapped = false
    var commit = function () {
      if (swapped) return
      swapped = true
      next.setAttribute('data-shown', '1')
      old.setAttribute('data-shown', '0')
      global.setTimeout(function () {
        try { old.pause(); old.removeAttribute('src'); old.load(); old.parentNode.removeChild(old) } catch (error) { /* noop */ }
      }, 1400)
    }
    next.addEventListener('playing', commit, { once: true })
    global.setTimeout(commit, 2200)
  }

  // ── active skin / persistence ──────────────────────────────────────────
  function persistActive(id) {
    storeActive(id)
    try {
      if (typeof global.fetch !== 'function') return
      var result = global.fetch(PREFIX + '/api/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: id }),
      })
      if (result && typeof result.catch === 'function') result.catch(function () {})
    } catch (error) {
      /* standalone preview has no host endpoint */
    }
  }

  function setActive(id, options) {
    var skin = findSkin(id)
    if (!skin) return false
    var opts = options || {}
    var changed = !activeSkin || activeSkin.id !== skin.id
    applySkin(skin)
    api.state.active = skin.id
    if (changed) persistActive(id)
    swapBackdrop(skin)
    updateSwitcher()
    if (opts.replayBoot) replayBoot()
    return true
  }

  function replayBoot() {
    if (disabled) return false
    destroyBoot()
    startBoot(activeSkin, { preview: true })
    return true
  }

  // ── switcher UI ────────────────────────────────────────────────────────
  function mountSwitcher() {
    if (disabled || cfg.ui && cfg.ui.switcher === false) return
    if (switcher !== null) return
    var button = el('button', 'dsh-abyss-switch-btn')
    button.type = 'button'
    button.title = '切换皮肤 (Alt+Shift+S)'
    button.setAttribute('aria-label', '切换皮肤')
    button.textContent = '◈'

    var panel = el('div', 'dsh-abyss-switch-panel')
    panel.setAttribute('data-open', '0')
    var head = el('div', 'dsh-abyss-switch-head')
    head.appendChild(el('span', 'dsh-abyss-switch-title', 'SKIN SWITCHER'))
    var close = el('button', 'dsh-abyss-switch-close', '×')
    close.type = 'button'
    head.appendChild(close)
    panel.appendChild(head)

    var list = el('div', 'dsh-abyss-switch-list')
    var cards = []
    skins.forEach(function (skin) {
      var card = el('button', 'dsh-abyss-skin-card')
      card.type = 'button'
      card.setAttribute('data-skin', skin.id)
      card.style.setProperty('--card-accent', skin.accent)
      var thumb = el('span', 'dsh-abyss-skin-thumb')
      if (skin.poster) thumb.style.backgroundImage = 'url("' + skin.poster + '")'
      thumb.style.setProperty('--thumb-accent', skin.accent)
      var copy = el('span', 'dsh-abyss-skin-copy')
      copy.appendChild(el('b', null, skin.name))
      copy.appendChild(el('small', null, skin.tagline || skin.description || ''))
      card.appendChild(thumb)
      card.appendChild(copy)
      card.addEventListener('click', function () {
        setActive(skin.id)
      })
      list.appendChild(card)
      cards.push(card)
    })
    panel.appendChild(list)

    var foot = el('div', 'dsh-abyss-switch-foot')
    var replay = el('button', 'dsh-abyss-replay-btn', '重播启动')
    replay.type = 'button'
    replay.addEventListener('click', function () {
      panel.setAttribute('data-open', '0')
      button.setAttribute('data-open', '0')
      replayBoot()
    })
    foot.appendChild(replay)
    foot.appendChild(el('span', 'dsh-abyss-switch-hint', 'Alt+Shift+S'))
    panel.appendChild(foot)

    function toggle(open) {
      var next = open === undefined ? panel.getAttribute('data-open') !== '1' : open
      panel.setAttribute('data-open', next ? '1' : '0')
      button.setAttribute('data-open', next ? '1' : '0')
    }

    button.addEventListener('click', function (event) {
      event.preventDefault()
      toggle()
    })
    close.addEventListener('click', function () { toggle(false) })
    doc.addEventListener('keydown', function (event) {
      if (!event.altKey || !event.shiftKey) return
      var key = String(event.key || '').toLowerCase()
      if (key === 's') {
        event.preventDefault()
        toggle()
      } else if (key === ']' || key === '}') {
        event.preventDefault()
        var index = skins.findIndex(function (skin) { return activeSkin && skin.id === activeSkin.id })
        var next = skins[(index + 1) % skins.length]
        if (next) setActive(next.id)
      } else if (key === 'b') {
        event.preventDefault()
        toggleBackground()
      } else if (key === 'x') {
        event.preventDefault()
        teardown()
      }
    }, true)

    if (!doc.body) return
    doc.body.appendChild(button)
    doc.body.appendChild(panel)
    switcher = { button: button, panel: panel, cards: cards, toggle: toggle }
    updateSwitcher()
  }

  function updateSwitcher() {
    if (!switcher) return
    switcher.cards.forEach(function (card) {
      card.setAttribute('data-active', activeSkin && card.getAttribute('data-skin') === activeSkin.id ? '1' : '0')
    })
  }

  function toggleBackground() {
    if (bg === null) {
      startBackdrop(activeSkin)
      return true
    }
    if (bg.kind === 'gallery' || bg.kind === 'image') {
      bg.paused = !bg.paused
      if (bg.paused) {
        if (bg.timer) {
          try { global.clearTimeout(bg.timer) } catch (error) { /* noop */ }
          bg.timer = null
        }
      } else {
        scheduleGallery()
      }
      bg.root.setAttribute('data-paused', bg.paused ? '1' : '0')
      return !bg.paused
    }
    var video = bg.video
    if (bg.paused) {
      bg.paused = false
      try {
        var p = video.play()
        if (p && typeof p.then === 'function') p.catch(function () {})
      } catch (error) { /* noop */ }
    } else {
      bg.paused = true
      try { video.pause() } catch (error) { /* noop */ }
    }
    bg.root.setAttribute('data-paused', bg.paused ? '1' : '0')
    return !bg.paused
  }

  function teardown() {
    disabled = true
    destroyBoot()
    destroyBackdrop()
    if (switcher) {
      try { switcher.button.parentNode.removeChild(switcher.button) } catch (error) { /* noop */ }
      try { switcher.panel.parentNode.removeChild(switcher.panel) } catch (error) { /* noop */ }
      switcher = null
    }
    doc.documentElement.removeAttribute('data-dsh-abyss')
    doc.documentElement.removeAttribute('data-dsh-abyss-skin')
    doc.documentElement.removeAttribute('data-dsh-abyss-fallback')
  }

  api.setActive = setActive
  api.replayBoot = replayBoot
  api.toggleBackground = toggleBackground
  api.startBackground = function () { startBackdrop(activeSkin) }
  api.teardown = teardown
  api.state.active = activeSkin.id

  // ── init ───────────────────────────────────────────────────────────────
  try {
    mountSwitcher()
    var noBoot = false
    try {
      noBoot = /[?&]abyss_noboot=1/u.test(String((global.location && global.location.search) || ''))
    } catch (error) { noBoot = false }
    if (noBoot) scheduleBackdrop(activeSkin)
    else if (doc.body) startBoot(activeSkin)
    else doc.addEventListener('DOMContentLoaded', function () { startBoot(activeSkin) }, { once: true })
  } catch (error) {
    fail('init', error)
    try { startBackdrop(activeSkin) } catch (ignored) { /* noop */ }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
