/**
 * Browser-half tests without a browser — dsh-usage-stats.
 *
 * A tiny React stand-in runs the real `client.js` in a `node:vm` sandbox:
 * hooks keep state between render passes, effects actually run (with a
 * dependency check and cleanups), and an injected `fetch` serves synthetic
 * reports. The tests cover the load/data/error/empty states, the 7/30/90
 * range switch, the scene/model chart grouping (including the "other" merge),
 * hover tooltips, the footer refresh, the 10 s poll registration, the four
 * locale dictionaries and the exported pure model functions.
 *
 * Nothing here touches the network or a real `$DSH_HOME`: the only files read
 * are this repo's `client.js` and `locale/*.json`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const LOCALE_DIR = path.join(ROOT, 'locale')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

// ---------------------------------------------------------------- harness

/** Keep sandbox timers from holding the test process alive. */
function unref(fn) {
  return (...args) => {
    const timer = fn(...args)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return timer
  }
}

/** One mini React runtime: per-component hook slots, effects with deps. */
function createRuntime() {
  const runtime = {
    /** component key -> { hooks: [], effects: [] } */
    slots: new Map(),
    currentKey: null,
    hookCursor: 0,
    dirty: false,
    pendingEffects: [],
    renders: 0,
  }

  const slotFor = (key) => {
    let slot = runtime.slots.get(key)
    if (slot === undefined) {
      slot = { hooks: [], effects: [] }
      runtime.slots.set(key, slot)
    }
    return slot
  }

  const currentSlot = () => slotFor(runtime.currentKey)

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.hooks[index]) : next
        if (!Object.is(value, slot.hooks[index])) {
          slot.hooks[index] = value
          runtime.dirty = true
        }
      }
      return [slot.hooks[index], setState]
    },
    useEffect(fn, deps) {
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      runtime.pendingEffects.push({ key: runtime.currentKey, index, fn, deps: deps === undefined ? undefined : [...deps] })
    },
    useRef(initial) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      if (!(index in slot.hooks)) slot.hooks[index] = { current: initial }
      return slot.hooks[index]
    },
    useMemo(fn, deps) {
      const slot = currentSlot()
      const index = runtime.hookCursor
      runtime.hookCursor += 1
      const record = slot.hooks[index]
      const wanted = deps === undefined ? undefined : [...deps]
      if (record !== undefined && record.deps !== undefined && wanted !== undefined && sameDeps(record.deps, wanted)) return record.value
      const value = fn()
      slot.hooks[index] = { deps: wanted, value }
      return value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    memo: (component) => component,
    Fragment: 'fragment',
  }

  runtime.React = React
  return runtime
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}

/**
 * Expand the element tree: host elements stay as nodes, function components
 * are called with their hooks keyed by tree position.
 */
function expand(node, runtime, treePath, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, runtime, treePath + '.' + index, depth))
  if (depth > 120) throw new Error('render tree too deep')
  const { type, props, children } = node
  if (typeof type === 'function') {
    const key = treePath + '#' + (type.name || 'Anonymous')
    const previousKey = runtime.currentKey
    const previousCursor = runtime.hookCursor
    runtime.currentKey = key
    runtime.hookCursor = 0
    let output
    try {
      const merged = { ...props }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      output = type(merged)
    } finally {
      runtime.currentKey = previousKey
      runtime.hookCursor = previousCursor
    }
    return expand(output, runtime, treePath, depth + 1)
  }
  const renderedChildren = children.flatMap((child, index) => expand(child, runtime, treePath + '.' + index, depth + 1))
  return [{ tag: type, props, children: renderedChildren }]
}

/** Commit pending effects, running cleanups when dependencies changed. */
async function commitEffects(runtime) {
  const pending = runtime.pendingEffects
  runtime.pendingEffects = []
  for (const effect of pending) {
    const slot = runtime.slots.get(effect.key)
    const record = slot.effects[effect.index]
    if (record !== undefined && sameDeps(record.deps, effect.deps)) continue
    if (record !== undefined && typeof record.cleanup === 'function') {
      try {
        record.cleanup()
      } catch {
        /* component cleanups must not fail the harness */
      }
    }
    const cleanup = effect.fn()
    slot.effects[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Render a component, settle all state/effects, and expose the tree. */
async function mount(load, component, props) {
  const { runtime, React } = load
  let tree = null

  const renderPass = () => {
    runtime.dirty = false
    runtime.pendingEffects = []
    runtime.renders += 1
    tree = expand(React.createElement(component, props), runtime, 'r')
  }

  const settle = async () => {
    for (let pass = 0; pass < 30; pass += 1) {
      renderPass()
      await commitEffects(runtime)
      await tick()
      if (!runtime.dirty) return
    }
    throw new Error('component did not settle after 30 passes')
  }

  await settle()

  const unmount = () => {
    for (const slot of runtime.slots.values()) {
      for (const record of slot.effects) {
        if (record !== undefined && typeof record.cleanup === 'function') {
          try {
            record.cleanup()
          } catch {
            /* ignore */
          }
          record.cleanup = undefined
        }
      }
    }
  }

  const current = () => {
    const view = collect(tree)
    view.rerender = async () => {
      await settle()
      return current()
    }
    view.unmount = unmount
    return view
  }
  return current()
}

/** Collect host nodes, text, classes, data attributes and aria state. */
function collect(tree) {
  const out = {
    nodes: [],
    text: [],
    joined: '',
    tags: [],
    classes: [],
    classSet: new Set(),
    data: [],
    titles: [],
    labels: [],
    pressed: [],
    styles: [],
  }

  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node === 'string') {
        out.text.push(node)
        continue
      }
      const { tag, props, children } = node
      out.nodes.push(node)
      out.tags.push(tag)
      if (typeof props.className === 'string') {
        out.classes.push(props.className)
        for (const cls of props.className.split(/\s+/)) if (cls !== '') out.classSet.add(cls)
      }
      for (const key of Object.keys(props)) {
        if (key.startsWith('data-')) out.data.push([key, String(props[key])])
      }
      if (props.title !== undefined) out.titles.push(String(props.title))
      if (props['aria-label'] !== undefined) out.labels.push(String(props['aria-label']))
      if (props['aria-pressed'] !== undefined) out.pressed.push(String(props['aria-pressed']))
      if (props.style !== null && typeof props.style === 'object') out.styles.push(props.style)
      // A `<style>` child is the component CSS string; never treat it as copy.
      if (tag === 'style') continue
      walk(children)
    }
  }

  walk(tree)
  out.joined = out.text.join(' ')
  const dataName = (key) => (key.startsWith('data-') ? key : 'data-' + key)
  out.dataValue = (key) => {
    const hit = out.data.find(([name]) => name === dataName(key))
    return hit === undefined ? undefined : hit[1]
  }
  out.dataValues = (key) => out.data.filter(([name]) => name === dataName(key)).map(([, value]) => value)
  /** Flatten every string under a host node (nested spans included). */
  out.textOf = (node) => {
    const parts = []
    const visit = (current) => {
      if (typeof current === 'string') parts.push(current)
      else if (Array.isArray(current)) for (const child of current) visit(child)
      else if (current !== null && typeof current === 'object') visit(current.children)
    }
    visit(node)
    return parts.join('')
  }
  out.buttons = out.nodes.filter((node) => node.tag === 'button')
  out.byClass = (cls) => out.nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(cls))
  out.byTag = (tag) => out.nodes.filter((node) => node.tag === tag)
  out.contains = (needle) => out.joined.includes(needle)
  return out
}

// ---------------------------------------------------------- client loader

/**
 * Load `client.js` into a fresh vm context and hand back the plugin exports.
 * `options.lang` controls the document/navigator language fallback, while
 * `options.fetchImpl` replaces the fake network layer.
 */
function loadClient(options = {}) {
  let factory = null
  let moduleId = null
  const lang = options.lang || 'zh-CN'
  const fetchCalls = []
  const intervalCalls = []
  const clearedIntervals = []

  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          moduleId = spec.id
          factory = spec.factory
        },
      },
    },
    document: {
      documentElement: { lang },
      baseURI: 'http://127.0.0.1:57822/',
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { language: lang },
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init })
      if (typeof options.fetchImpl === 'function') return options.fetchImpl(String(url), init)
      return Promise.resolve(jsonResponse(options.payload ?? { ok: true }))
    },
    // The page polls every 10 s; record the registration instead of firing it.
    setInterval: (fn, ms) => {
      const id = intervalCalls.length + 1
      intervalCalls.push({ id, ms })
      return id
    },
    clearInterval: (id) => {
      clearedIntervals.push(id)
    },
    setTimeout: unref(setTimeout),
    clearTimeout,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  if (factory === null) throw new Error('client.js did not register a __ModuleLoader__ factory')

  const runtime = createRuntime()
  const moduleExports = factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error('unexpected require: ' + name)
  })

  return {
    moduleId,
    moduleExports,
    model: moduleExports.__model,
    runtime,
    React: runtime.React,
    fetchCalls,
    intervalCalls,
    clearedIntervals,
    sandbox,
  }
}

/**
 * Load the client and return the model surface plus a fake `apply()` context.
 * `locale` seeds the fake locale service (`{active}` shape by default).
 */
function loadWithContext(options = {}) {
  const load = loadClient(options)
  const slotRegistrations = []
  const localeRegistrations = []
  const effectLabels = []
  const localeService = {
    getLocale() {
      return { active: options.activeLocale || 'zh' }
    },
    getSnapshot() {
      return { active: options.activeLocale || 'zh' }
    },
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
  }
  const ctx = {
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    locale: localeService,
    slots: {
      inject(name, callback) {
        return callback()
      },
      register(slotOptions, component) {
        slotRegistrations.push({ slotOptions, component })
        return () => {}
      },
    },
  }
  load.moduleExports.apply(ctx)
  return { load, slotRegistrations, localeRegistrations, effectLabels }
}

// ------------------------------------------------------------- fixtures

const CATEGORIES = ['chat', 'cowork', 'code']
const MODEL_NAMES = [
  'deepseek-v4.1-flash',
  'qwen4-max-preview',
  'deepseek-flash',
  'model-4',
  'model-5',
  'model-6',
  'model-7',
  'model-8',
]
const MODEL_PROVIDERS = [
  ['opencode-go', 'qwen-token-plan-cn'],
  ['qwen-token-plan-cn'],
  ['deepseek-account'],
]
const MODEL_CACHE_READ_PER_DAY = [250000, 40000, 10000, 0, 0, 0, 0, 0]
const DEFAULT_MODEL_IOS = [448000, 168000, 55000]
/** Category buckets per day; they add up to 671 000 input+output tokens a day. */
const CATEGORY_PER_DAY = {
  chat: { input: 900, output: 100, cacheRead: 300000, cacheWrite: 0, web: 1, sessions: 1 },
  cowork: { input: 100000, output: 20000, cacheRead: 0, cacheWrite: 0, web: 2, sessions: 2 },
  code: { input: 500000, output: 50000, cacheRead: 0, cacheWrite: 1000, web: 3, sessions: 3 },
}
const LAST_DAY = Date.UTC(2026, 10, 12) // 2026-11-12, matches the real sample
const DAY_MS = 86400000
/** A repeating 1/0/2 spike pattern keeps the daily sum equal to the totals. */
const dayScale = (index) => [1, 0, 2][index % 3]

function dayList(days) {
  const out = []
  for (let index = days - 1; index >= 0; index -= 1) out.push(new Date(LAST_DAY - index * DAY_MS).toISOString().slice(0, 10))
  return out
}

/**
 * Build a SPEC §4.3-shaped report. Totals, cards, chart and table all agree
 * with each other, so the assertions can check cross-component consistency.
 */
function makeReport(days = 30, options = {}) {
  const modelIos = options.modelIos ?? DEFAULT_MODEL_IOS
  const days_ = dayList(days)
  const categories = {}
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 }
  for (const category of CATEGORIES) {
    const perDay = CATEGORY_PER_DAY[category]
    categories[category] = {
      input: perDay.input * days,
      output: perDay.output * days,
      cacheRead: perDay.cacheRead * days,
      cacheWrite: perDay.cacheWrite * days,
      webSearches: perDay.web * days,
      sessions: perDay.sessions,
    }
    totals.input += categories[category].input
    totals.output += categories[category].output
    totals.cacheRead += categories[category].cacheRead
    totals.cacheWrite += categories[category].cacheWrite
    totals.webSearches += categories[category].webSearches
    totals.sessions += categories[category].sessions
  }

  const modelsPerDay = modelIos.map((io) => {
    const output = Math.round(io / 10)
    return { input: io - output, output }
  })
  const models = modelIos.map((io, index) => {
    const perDay = modelsPerDay[index]
    return {
      model: MODEL_NAMES[index] ?? 'model-' + (index + 1),
      providers: MODEL_PROVIDERS[index] ?? ['provider-' + (index + 1)],
      input: perDay.input * days,
      output: perDay.output * days,
      cacheRead: (MODEL_CACHE_READ_PER_DAY[index] ?? 0) * days,
      cacheWrite: 0,
      webSearches: index,
      sessions: 5 + index,
    }
  })

  const daily = days_.map((day, index) => {
    const scale = dayScale(index)
    const dayCategories = {}
    for (const category of CATEGORIES) {
      const perDay = CATEGORY_PER_DAY[category]
      dayCategories[category] = {
        input: perDay.input * scale,
        output: perDay.output * scale,
        cacheRead: perDay.cacheRead * scale,
        cacheWrite: perDay.cacheWrite * scale,
      }
    }
    const dayModels = {}
    modelsPerDay.forEach((perDay, modelIndex) => {
      const name = MODEL_NAMES[modelIndex] ?? 'model-' + (modelIndex + 1)
      dayModels[name] = {
        input: perDay.input * scale,
        output: perDay.output * scale,
        cacheRead: (MODEL_CACHE_READ_PER_DAY[modelIndex] ?? 0) * scale,
        cacheWrite: 0,
      }
    })
    return { day, categories: dayCategories, models: dayModels }
  })

  return {
    ok: true,
    generatedAt: 1794458505000,
    buildMs: 12,
    days,
    range: { from: days_[0], to: days_[days_.length - 1] },
    tzOffsetMinutes: 480,
    index: { sessions: 31, scanned: 0, reused: 31, skipped: 0, files: 31 },
    categories,
    totals,
    models,
    daily,
  }
}

/** A successful report whose whole range is empty. */
function makeEmptyReport(days = 30) {
  const days_ = dayList(days)
  const emptyBucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const categories = {}
  const daily = []
  for (const category of CATEGORIES) {
    categories[category] = { ...emptyBucket(), webSearches: 0, sessions: 0 }
  }
  for (const day of days_) {
    const dayCategories = {}
    for (const category of CATEGORIES) dayCategories[category] = emptyBucket()
    daily.push({ day, categories: dayCategories, models: {} })
  }
  return {
    ok: true,
    generatedAt: 1794458505000,
    buildMs: 3,
    days,
    range: { from: days_[0], to: days_[days_.length - 1] },
    tzOffsetMinutes: 480,
    index: { sessions: 0, scanned: 0, reused: 0, skipped: 0, files: 0 },
    categories,
    totals: { ...emptyBucket(), webSearches: 0, sessions: 0 },
    models: [],
    daily,
  }
}

const TOTAL_IO_PER_DAY = DEFAULT_MODEL_IOS.reduce((sum, io) => sum + io, 0) // 671 000
const ZERO_DAYS = 30

/** Fake fetch that serves the report matching `?days=N`. */
function fetchByDays(options = {}) {
  return (url) => {
    const match = /[?&]days=(\d+)/.exec(url)
    const days = match === null ? 30 : Number(match[1])
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (options.empty ? makeEmptyReport(days) : makeReport(days, options)),
    })
  }
}

// ------------------------------------------------------------ test runner

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.error('FAIL -', name)
    console.error(String(error && error.stack ? error.stack : error).split('\n').slice(0, 6).join('\n'))
  }
}

// ============================================================ module surface

await test('module registers under the plugin id and exports the model surface', () => {
  const load = loadClient()
  const model = load.model
  assert.equal(load.moduleId, '@ruaibeite/dsh-usage-stats')
  assert.deepEqual([...load.moduleExports.inject], ['slots', 'locale'])
  assert.equal(typeof load.moduleExports.apply, 'function')
  const required = [
    'TEXT',
    'NS',
    'ROUTE',
    'RANGES',
    'CATEGORIES',
    'fmtTokens',
    'fmtPct',
    'fmtClock',
    'formatDayLabel',
    'aggregateSeries',
    'niceMax',
    'parseReport',
    'UsageSection',
    'UsageChart',
    'UsageCards',
    'ModelTable',
    'UsageIcon',
    'UsageHeader',
    'activeLanguage',
    'pageIsChinese',
  ]
  for (const key of required) assert.notEqual(model[key], undefined, 'missing __model.' + key)
  assert.equal(model.NS, '@ruaibeite/dsh-usage-stats')
  assert.equal(model.ROUTE, '/dsh-usage-stats/report')
  assert.deepEqual([...model.RANGES], [7, 30, 90])
  assert.deepEqual([...model.CATEGORIES], CATEGORIES)
  assert.equal(model.MODEL_SERIES_CAP, 6)
})

await test('apply registers dictionaries, nav entry, icon and language getter', () => {
  const { slotRegistrations, localeRegistrations, effectLabels } = loadWithContext({ activeLocale: 'zh' })
  assert.equal(effectLabels.length, 1)
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, '@ruaibeite/dsh-usage-stats')
  assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries), ['zh', 'en'])
  assert.equal(slotRegistrations.length, 2)
  const section = slotRegistrations[0].slotOptions
  assert.equal(section.name, 'settings.section')
  assert.equal(section.id, 'usage')
  assert.equal(section.order, 2)
  assert.equal(section.locale, '@ruaibeite/dsh-usage-stats')
  assert.equal(section.label(), '用量')
  const injected = section.inject()
  assert.equal(typeof injected.fetchReport, 'function')
  assert.equal(typeof injected.getLanguage, 'function')
  assert.equal(injected.getLanguage(), 'zh')
  assert.equal(typeof slotRegistrations[0].component, 'function')
  const icon = slotRegistrations[1].slotOptions
  assert.equal(icon.name, 'settings.section.icon')
  assert.equal(icon.id, 'usage')
})

await test('nav label and page language follow the active locale service', () => {
  const { slotRegistrations } = loadWithContext({ activeLocale: 'en' })
  const section = slotRegistrations[0].slotOptions
  assert.equal(section.label(), 'Usage')
  assert.equal(section.inject().getLanguage(), 'en')

  const zhLoad = loadClient({ lang: 'zh-CN' })
  const model = zhLoad.model
  assert.equal(model.activeLanguage({ locale: { getLocale: () => ({ active: 'en' }) } }), 'en')
  assert.equal(model.activeLanguage({ locale: { getSnapshot: () => ({ active: 'zh' }) } }), 'zh')
  assert.equal(model.activeLanguage({ locale: { getLocale: () => ({ active: '' }) } }), 'zh')
  assert.equal(model.activeLanguage({}), 'zh')
  assert.equal(model.activeLanguage(undefined), 'zh')

  assert.equal(model.pageIsChinese({ getLanguage: () => 'en' }), false)
  assert.equal(model.pageIsChinese({ getLanguage: () => 'zh' }), true)
  assert.equal(model.pageIsChinese({}), true)

  const enLoad = loadClient({ lang: 'en-US' })
  assert.equal(enLoad.model.isChinese(), false)
  assert.equal(enLoad.model.pageIsChinese(undefined), false)
})

await test('bundled TEXT matches locale/zh.json and locale/en.json key-for-key', () => {
  const load = loadClient()
  const TEXT = load.model.TEXT
  for (const lang of ['zh', 'en']) {
    const filePath = path.join(LOCALE_DIR, lang + '.json')
    const dictionary = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(TEXT[lang]).sort(), lang + ' key sets differ')
    for (const key of Object.keys(dictionary)) assert.equal(dictionary[key], TEXT[lang][key], lang + ':' + key)
  }
  for (const lang of ['zh', 'en']) {
    assert.equal(typeof TEXT[lang]['meta.title'], 'string')
    assert.equal(typeof TEXT[lang]['meta.description'], 'string')
    assert.notEqual(TEXT[lang]['meta.title'], '')
  }
  assert.equal(TEXT.zh['nav'], '用量')
  assert.equal(TEXT.en['nav'], 'Usage')
  assert.equal(TEXT.zh['metric.input'], '未缓存输入')
  assert.equal(TEXT.en['metric.input'], 'Uncached input')
})

// ============================================================ pure helpers

await test('fmtTokens formats 0 / 999 / 37.6K / 11.6M / 1.2B and unit carries', () => {
  const { fmtTokens } = loadClient().model
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(1000), '1K')
  assert.equal(fmtTokens(1500), '1.5K')
  assert.equal(fmtTokens(37600), '37.6K')
  assert.equal(fmtTokens(376000), '376K')
  assert.equal(fmtTokens(999499), '999K')
  assert.equal(fmtTokens(999500), '1M')
  assert.equal(fmtTokens(11636785), '11.6M')
  assert.equal(fmtTokens(1200000000), '1.2B')
  assert.equal(fmtTokens(-5), '0')
  assert.equal(fmtTokens('nope'), '0')
})

await test('fmtExact / fmtPct / fmtClock format detail values', () => {
  const model = loadClient().model
  assert.equal(model.fmtExact(0), '0')
  assert.equal(model.fmtExact(20130000), '20,130,000')
  assert.equal(model.fmtExact(13440000), '13,440,000')
  assert.equal(model.fmtPct(0), '0.0%')
  assert.equal(model.fmtPct(0.3326), '33.3%')
  assert.equal(model.fmtPct(1), '100.0%')
  assert.equal(model.fmtClock(0), '—')
  assert.match(model.fmtClock(1794458505000), /^\d{2}:\d{2}:\d{2}$/)
})

await test('formatDayLabel and niceMax handle ranges and bad input', () => {
  const model = loadClient().model
  assert.equal(model.formatDayLabel('2026-10-14', true), '10-14')
  assert.equal(model.formatDayLabel('2026-10-14', false), 'Oct 14')
  assert.equal(model.formatDayLabel('2026-01-05', false), 'Jan 5')
  assert.equal(model.formatDayLabel('not-a-day', true), 'not-a-day')
  assert.equal(model.formatDayLabel(null, true), '')
  assert.equal(model.niceMax(0), 0)
  assert.equal(model.niceMax(1), 1)
  assert.equal(model.niceMax(99), 100)
  assert.equal(model.niceMax(100), 100)
  assert.equal(model.niceMax(1234), 1500)
  assert.equal(model.niceMax(8200000), 10000000)
  assert.equal(model.niceMax(2013000), 2500000)
})

await test('parseReport rejects bad payloads and normalizes a report', () => {
  const { parseReport } = loadClient().model
  assert.equal(parseReport(null), null)
  assert.equal(parseReport(undefined), null)
  assert.equal(parseReport([1, 2]), null)
  assert.equal(parseReport({ ok: false }), null)
  assert.equal(parseReport('nope'), null)

  const bare = parseReport({ ok: true })
  assert.notEqual(bare, null)
  assert.equal(bare.days, 30)
  assert.deepEqual(JSON.parse(JSON.stringify(bare.categories.chat)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 })
  assert.deepEqual([...bare.models], [])
  assert.deepEqual([...bare.daily], [])

  const report = makeReport(30)
  const parsed = parseReport(report)
  assert.equal(parsed.days, 30)
  assert.equal(parsed.range.from, '2026-10-14')
  assert.equal(parsed.range.to, '2026-11-12')
  assert.equal(parsed.totals.input, 18027000)
  assert.equal(parsed.totals.output, 2103000)
  assert.equal(parsed.models.length, 3)
  assert.equal(parsed.daily.length, 30)
  assert.equal(parsed.models[0].providers.length, 2)

  const hostile = parseReport({
    ok: true,
    days: 45,
    range: { from: 'nope', to: null },
    categories: { chat: { input: -5, output: 'x', cacheRead: null } },
    totals: null,
    models: [
      { model: 'bad-values', input: -1, output: -2 },
      { model: 'kept', providers: ['p', 'p', 42], input: 10, output: 5 },
      { input: 7, output: 3 },
      'garbage',
    ],
    daily: [
      { day: '2026-11-12', categories: { chat: { input: 1 } }, models: { done: { input: 1 } } },
      { day: 'bad-day', categories: {}, models: {} },
      null,
    ],
  })
  assert.equal(hostile.days, 30, 'unknown range falls back to 30')
  assert.deepEqual(JSON.parse(JSON.stringify(hostile.range)), { from: '', to: '' })
  assert.deepEqual(JSON.parse(JSON.stringify(hostile.categories.chat)), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 })
  assert.equal(hostile.totals.sessions, 0)
  // "bad-values" normalizes to 0/0/0/0 but keeps its name; a nameless row with
  // tokens becomes "unknown"; a non-object row with no tokens is dropped.
  assert.deepEqual([...hostile.models].map((row) => row.model), ['bad-values', 'kept', 'unknown'])
  assert.equal(hostile.models[2].input + hostile.models[2].output, 10)
  assert.deepEqual([...hostile.models[1].providers], ['p'])
  assert.equal(hostile.models[1].input, 10)
  assert.equal(hostile.daily.length, 1)
  assert.equal(hostile.daily[0].day, '2026-11-12')
})

await test('aggregateSeries fills missing categories and respects the model cap', () => {
  const { aggregateSeries } = loadClient().model
  const bareDaily = [
    { day: '2026-11-01', categories: { chat: { input: 10, output: 1 } }, models: { a: { input: 100, output: 10 } } },
    { day: '2026-11-02', categories: { chat: { input: 20, output: 2 }, cowork: { input: 5, output: 5 } }, models: { b: { input: 200, output: 20 } } },
  ]
  const category = aggregateSeries(bareDaily, 'category')
  assert.deepEqual([...category.days], ['2026-11-01', '2026-11-02'])
  assert.deepEqual([...category.series].map((entry) => entry.key), ['chat', 'cowork', 'code'])
  assert.deepEqual([...category.series[0].values], [11, 22])
  assert.deepEqual([...category.series[1].values], [0, 10])
  assert.deepEqual([...category.series[2].values], [0, 0])
  assert.equal(category.total, 43)
  assert.equal(category.max, 32)

  const modelIos = [448000, 168000, 20000, 15000, 10000, 5000, 3000, 2000]
  const report = makeReport(30, { modelIos })
  const parsed = loadClient().model.parseReport(report)
  const model = aggregateSeries(parsed, 'model')
  assert.deepEqual([...model.series].map((entry) => entry.key), [...MODEL_NAMES.slice(0, 6), 'other'])
  assert.equal(model.series.length, 7)
  const scales = report.daily.map((row, index) => dayScale(index))
  const expectedOther = 5000 * scales.reduce((sum, value) => sum + value, 0)
  assert.equal(model.series[6].values.reduce((sum, value) => sum + value, 0), expectedOther)
  assert.equal(model.total, TOTAL_IO_PER_DAY * ZERO_DAYS)
  // Zero-usage models never become series.
  const sparse = aggregateSeries([{ day: '2026-11-01', models: { a: { input: 5, output: 0 }, b: { input: 0, output: 0 } } }], 'model')
  assert.deepEqual([...sparse.series].map((entry) => entry.key), ['a'])
})

await test('cacheHitRatio, series labels/colors and textOf behave', () => {
  const model = loadClient().model
  assert.equal(model.cacheHitRatio({ input: 100, cacheRead: 300, cacheWrite: 0 }), 0.75)
  assert.equal(model.cacheHitRatio({}), 0)

  const tr = model.textOf(undefined, true)
  assert.equal(model.seriesLabel(tr, 'chat'), 'Chat')
  assert.equal(model.seriesLabel(tr, 'other'), '其他')
  assert.equal(model.seriesLabel(tr, 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash')

  assert.equal(model.seriesColor('chat', 0, 'category'), 'var(--dsw-alias-state-business-primary, #4176e6)')
  assert.equal(model.seriesColor('cowork', 1, 'category'), 'var(--dsw-alias-state-warn-primary, #f59e0b)')
  assert.equal(model.seriesColor('code', 2, 'category'), 'var(--dsw-alias-state-success-primary, #22c55e)')
  assert.equal(model.seriesColor('m0', 0, 'model'), 'var(--dsw-alias-state-business-primary, #4176e6)')
  assert.notEqual(model.seriesColor('m0', 0, 'model'), model.seriesColor('m1', 1, 'model'))

  const translated = model.textOf((key) => 'T:' + key, false)
  assert.equal(translated('title'), 'T:title')
  assert.equal(translated('summary.sessions', { n: 7 }), 'T:summary.sessions')
  const fallback = model.textOf((key) => key, true)
  assert.equal(fallback('title'), '用量统计')
  assert.equal(fallback('summary.sessions', { n: 12 }), '12 个会话')
  assert.equal(model.textOf(undefined, true)('no.such.key'), 'no.such.key')
})

// ============================================================== rendering

await test('loading state shows skeleton cards, spinner and the scan hint', async () => {
  const load = loadClient({ fetchImpl: () => new Promise(() => {}) })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(out.dataValue('days'), '30')
  assert.equal(out.dataValue('loading'), '1')
  assert.ok(out.contains('正在汇总本机会话…'))
  assert.ok(out.contains('首次打开需要扫描本机会话日志'))
  assert.ok(out.classSet.has('us-spinner'))
  assert.ok(out.classSet.has('us-loading'))
  assert.equal(out.byClass('us-skeleton-card').length, 3)
  assert.equal(out.byClass('us-skeleton-chart').length, 1)
  assert.equal(out.byClass('us-card').length, 0)
  assert.equal(out.byClass('us-chart-svg').length, 0)
  out.unmount()
})

await test('data state renders title, chips, three scene cards with exact rows', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(out.dataValue('loading'), '0')
  assert.ok(out.contains('用量统计'))
  assert.ok(out.contains('费用不显示'))
  assert.ok(out.contains('6 个会话'), 'summary sessions')
  assert.ok(out.contains('3 个模型'), 'summary models')
  assert.ok(out.contains('缓存命中率 33.3%'), 'cache hit ratio')

  const cards = out.byClass('us-card')
  assert.equal(cards.length, 3)
  assert.deepEqual(out.dataValues('data-cat'), ['chat', 'cowork', 'code'])
  const ioByCategory = out.byClass('us-card-big').map((node) => node.props['data-io'])
  assert.deepEqual(ioByCategory, ['30000', '3600000', '16500000'])
  const bigNumbers = out.byClass('us-card-big').map((node) => node.children.join(''))
  assert.deepEqual(bigNumbers, ['30K', '3.6M', '16.5M'])
  assert.equal(out.byClass('us-card-hint').length, 3)
  assert.ok(out.contains('纯对话'))
  assert.ok(out.contains('Agent Teams'))
  assert.ok(out.contains('代码执行'))
  assert.equal(out.byClass('us-row').length, 12)
  const labels = out.byClass('us-row-label').map((node) => node.children.join(''))
  for (const label of ['未缓存输入', '输出', '缓存读', '缓存写']) assert.ok(labels.includes(label), 'missing row ' + label)
  assert.ok(out.contains('30 次联网搜索'))
  assert.ok(out.contains('60 次联网搜索'))
  assert.ok(out.contains('90 次联网搜索'))
  assert.ok(out.contains('服务商账单覆盖整个组织并计入缓存 token'))
  assert.ok(out.contains('由本机会话日志推导'))
  assert.ok(out.contains('已索引 31 个会话'))
  out.unmount()
})

await test('scene chart has grouped bars, legend, axis and consistent totals', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  const chartPanel = out.nodes.find((node) => node.props && node.props.className === 'us-panel' && node.props['data-mode'] === 'category')
  assert.notEqual(chartPanel, undefined, 'chart panel in category mode')
  assert.equal(out.byClass('us-chart-svg').length, 1)
  const wraps = out.byClass('us-chart-wrap')
  assert.equal(wraps.length, 1)
  assert.equal(wraps[0].props['data-total'], '20130000')
  const series = wraps[0].props['data-series']
  assert.match(series, /^chat=30000,cowork=3600000,code=16500000$/)
  const legend = out.byClass('us-legend-item').map(out.textOf)
  assert.deepEqual(legend, ['Chat', 'Cowork', 'Code'])
  // 30 days x 3 scene bars, plus one hover overlay per day.
  const bars = out.nodes.filter((node) => node.tag === 'rect' && node.props.fill === 'var(--dsw-alias-state-business-primary, #4176e6)')
  assert.equal(bars.length, 30)
  assert.equal(out.byClass('us-dot').length, 3)
  assert.ok(out.contains('每日 Token'))
  assert.ok(out.contains('最近 30 天，按场景统计的输入与输出 token'))
  assert.equal(out.byClass('us-empty').length, 0)
  assert.ok(out.joined.includes('10-14'), 'first x label')
  assert.ok(out.joined.includes('11-12'), 'last x label')
  const axisText = out.byTag('text').map((node) => node.children.join(''))
  for (const tick of ['375K', '750K', '1.1M', '1.5M']) assert.ok(axisText.includes(tick), 'missing y tick ' + tick)
  out.unmount()
})

await test('model table renders four columns, descending rows and a total', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  const table = out.nodes.find((node) => node.props && node.props['data-card'] === 'models')
  assert.notEqual(table, undefined)
  const header = out.byClass('us-th')[0]
  assert.deepEqual(header.children.map((child) => child.children.join('')), ['模型', '输入 + 输出', '缓存读', '占比'])
  assert.equal(out.byClass('us-table-inner').length, 1)
  const rows = out.nodes.filter((node) => node.props && node.props['data-model'] !== undefined)
  assert.deepEqual(rows.map((node) => node.props['data-model']), ['deepseek-v4.1-flash', 'qwen4-max-preview', 'deepseek-flash'])
  assert.deepEqual(rows.map((node) => node.props['data-io']), ['13440000', '5040000', '1650000'])
  const ios = rows.map((node) => node.props['data-io']).map(Number)
  assert.ok(ios[0] > ios[1] && ios[1] > ios[2], 'rows are sorted by input+output')
  const firstName = rows[0].children[0].children[0]
  assert.equal(firstName.children.join(''), 'deepseek-v4.1-flash')
  const providers = rows[0].children[0].children[1]
  assert.equal(providers.children.join(''), 'opencode-go · qwen-token-plan-cn')
  const ioCell = rows[0].children[1]
  assert.match(ioCell.props.title, /输入 12,096,000/)
  assert.match(ioCell.props.title, /输出 1,344,000/)
  assert.equal(ioCell.children.join(''), '13,440,000')
  assert.equal(rows[0].children[2].children.join(''), '7,500,000')
  const sharePct = rows.map((row) => row.children[3].children[1].children.join(''))
  assert.deepEqual(sharePct, ['66.8%', '25.0%', '8.2%'])
  const totalRow = out.byClass('us-tr-total')[0]
  assert.equal(totalRow.props['data-total'], '1')
  assert.deepEqual(totalRow.children.map((cell) => cell.children.map(String).join('')), ['合计', '20,130,000', '9,000,000', '100.0%'])
  assert.ok(out.contains('最近 30 天，按模型汇总'))
  out.unmount()
})

await test('7/30/90 switch refetches the right range and refreshes the numbers', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.deepEqual(load.fetchCalls.map((call) => call.url), ['/dsh-usage-stats/report?days=30'])
  assert.equal(out.dataValue('days'), '30')

  let next = await out.rerender()
  const rangeButtons = next.buttons.filter((button) => ['7', '30', '90'].includes(button.props['data-value']))
  assert.equal(rangeButtons.length, 3)
  assert.deepEqual(rangeButtons.map((button) => button.props['data-value']), ['7', '30', '90'])
  assert.deepEqual(rangeButtons.map((button) => button.props['aria-pressed']), ['false', 'true', 'false'])
  rangeButtons[0].props.onClick()
  next = await out.rerender()
  assert.equal(next.dataValue('days'), '7')
  assert.equal(load.fetchCalls[load.fetchCalls.length - 1].url, '/dsh-usage-stats/report?days=7')
  assert.equal(next.byClass('us-chart-wrap')[0].props['data-total'], '4697000')
  assert.deepEqual(next.byClass('us-card-big').map((node) => node.props['data-io']), ['7000', '840000', '3850000'])
  assert.ok(next.contains('最近 7 天，按场景统计的输入与输出 token'))
  assert.deepEqual(next.buttons.filter((button) => ['7', '30', '90'].includes(button.props['data-value'])).map((button) => button.props['aria-pressed']), ['true', 'false', 'false'])

  next.buttons.filter((button) => button.props['data-value'] === '90')[0].props.onClick()
  next = await out.rerender()
  assert.equal(next.dataValue('days'), '90')
  assert.equal(load.fetchCalls[load.fetchCalls.length - 1].url, '/dsh-usage-stats/report?days=90')
  assert.equal(next.byClass('us-chart-wrap')[0].props['data-total'], '60390000')
  assert.deepEqual(next.byClass('us-card-big').map((node) => node.props['data-io']), ['90000', '10800000', '49500000'])
  out.unmount()
})

await test('chart grouping switches between scene and model bars', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  let next = await out.rerender()
  assert.equal(next.dataValue('mode'), 'category')
  const modeButton = next.buttons.find((button) => button.props['data-value'] === 'model')
  assert.notEqual(modeButton, undefined)
  assert.equal(modeButton.props['aria-pressed'], 'false')
  modeButton.props.onClick()
  next = await out.rerender()
  assert.equal(next.dataValue('mode'), 'model')
  const modelPanel = next.nodes.find((node) => node.props && node.props.className === 'us-panel' && node.props['data-mode'] === 'model')
  assert.notEqual(modelPanel, undefined)
  assert.deepEqual(next.byClass('us-legend-item').map(next.textOf), ['deepseek-v4.1-flash', 'qwen4-max-preview', 'deepseek-flash'])
  assert.ok(next.contains('最近 30 天，按模型统计的输入与输出 token'))
  const wrap = next.byClass('us-chart-wrap')[0]
  assert.equal(wrap.props['data-total'], '20130000')
  assert.match(wrap.props['data-series'], /^deepseek-v4\.1-flash=13440000,qwen4-max-preview=5040000,deepseek-flash=1650000$/)
  // Stacked model bars skip zero-value days (the fixture's 1/0/2 spike pattern).
  const modelDots = next.nodes.filter((node) => node.tag === 'rect' && node.props.fill === 'var(--dsw-alias-state-business-primary, #4176e6)')
  assert.equal(modelDots.length, 20)
  next.buttons.find((button) => button.props['data-value'] === 'category').props.onClick()
  next = await out.rerender()
  assert.equal(next.dataValue('mode'), 'category')
  assert.deepEqual(next.byClass('us-legend-item').map(next.textOf), ['Chat', 'Cowork', 'Code'])
  out.unmount()
})

await test('more than six models merge into an "other" series', async () => {
  const modelIos = [448000, 168000, 20000, 15000, 10000, 5000, 3000, 2000]
  const load = loadClient({ fetchImpl: fetchByDays({ modelIos }) })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  let next = await out.rerender()
  next.buttons.find((button) => button.props['data-value'] === 'model').props.onClick()
  next = await out.rerender()
  const legend = next.byClass('us-legend-item').map(next.textOf)
  assert.equal(legend.length, 7)
  assert.equal(legend[6], '其他')
  const wrap = next.byClass('us-chart-wrap')[0]
  assert.ok(wrap.props['data-series'].endsWith(',other=' + 5000 * 30), wrap.props['data-series'])
  assert.equal(next.nodes.filter((node) => node.props && node.props.className === 'us-tr' && node.props['data-model'] !== undefined).length, 8)
  out.unmount()
})

await test('hovering a day shows a tooltip and mouse leave hides it', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  let next = await out.rerender()
  const overlays = next.nodes.filter((node) => node.tag === 'rect' && node.props.fill === 'transparent')
  assert.equal(overlays.length, 30)
  overlays[29].props.onMouseEnter()
  next = await out.rerender()
  const tooltip = next.byClass('us-tooltip')
  assert.equal(tooltip.length, 1)
  const tooltipText = next.textOf(tooltip[0])
  // The last day spikes to scale 2: 2 000 + 240 000 + 1 100 000 = 1 342 000.
  assert.ok(tooltipText.includes('11-12'), tooltipText)
  assert.ok(tooltipText.includes('合计'), tooltipText)
  assert.ok(tooltipText.includes('1.3M'), tooltipText)
  assert.ok(tooltipText.includes('Cowork'), tooltipText)
  assert.equal(tooltip[0].props.style.left >= 4, true)
  const svg = next.byClass('us-chart-svg')[0]
  svg.props.onMouseLeave()
  next = await out.rerender()
  assert.equal(next.byClass('us-tooltip').length, 0)
  out.unmount()
})

await test('footer refresh button refetches and updates the clock', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(load.fetchCalls.length, 1)
  let next = await out.rerender()
  const refresh = next.byClass('us-refresh')
  assert.equal(refresh.length, 1)
  assert.equal(refresh[0].children.join(''), '刷新')
  assert.ok(next.contains('更新于'))
  refresh[0].props.onClick()
  next = await out.rerender()
  assert.equal(load.fetchCalls.length, 2, 'refresh triggers one more report request')
  assert.equal(load.fetchCalls[1].url, '/dsh-usage-stats/report?days=30')
  out.unmount()
})

await test('error state offers a retry that recovers into the data view', async () => {
  let calls = 0
  const load = loadClient({
    fetchImpl: () => {
      calls += 1
      if (calls === 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
      return Promise.resolve({ ok: true, status: 200, json: async () => makeReport(30) })
    },
  })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(out.dataValue('loading'), '0')
  assert.ok(out.contains('读取用量失败'))
  assert.ok(out.contains('HTTP 500'))
  const retry = out.byClass('us-retry')
  assert.equal(retry.length, 1)
  assert.equal(retry[0].children.join(''), '重试')
  let next = await out.rerender()
  next.byClass('us-retry')[0].props.onClick()
  next = await out.rerender()
  assert.equal(calls, 2)
  assert.equal(next.byClass('us-retry').length, 0)
  assert.equal(next.byClass('us-card').length, 3)
  assert.ok(next.contains('用量统计'))
  out.unmount()
})

await test('an invalid payload is reported instead of crashing', async () => {
  const load = loadClient({ fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false }) }) })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.ok(out.contains('读取用量失败'))
  assert.ok(out.contains('invalid usage report'))
  out.unmount()
})

await test('empty range renders empty chart and table copy with zero cards', async () => {
  const load = loadClient({ fetchImpl: fetchByDays({ empty: true }) })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(out.dataValue('loading'), '0')
  assert.deepEqual(out.byClass('us-card-big').map((node) => node.children.join('')), ['0', '0', '0'])
  assert.ok(out.contains('0 个会话'))
  assert.ok(out.contains('0 个模型'))
  assert.ok(out.contains('缓存命中率 0.0%'))
  assert.equal(out.byClass('us-chart-svg').length, 0)
  assert.equal(out.byClass('us-empty').length, 2)
  assert.ok(out.contains('这段时间还没有用量'))
  assert.ok(out.contains('还没有模型数据'))
  const emptyText = out.byClass('us-empty').map((node) => node.children.join(''))
  assert.deepEqual(emptyText, ['这段时间还没有用量', '还没有模型数据'])
  out.unmount()
})

await test('a failed quiet refresh keeps the previous data and flags it', async () => {
  let calls = 0
  const load = loadClient({
    fetchImpl: () => {
      calls += 1
      if (calls === 1) return Promise.resolve({ ok: true, status: 200, json: async () => makeReport(30) })
      return Promise.reject(new Error('network down'))
    },
  })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  let next = await out.rerender()
  next.byClass('us-refresh')[0].props.onClick()
  next = await out.rerender()
  assert.equal(calls, 2)
  assert.equal(next.byClass('us-card').length, 3, 'stale data is retained')
  assert.ok(next.contains('刷新失败，显示上次结果'))
  assert.ok(next.contains('用量统计'))
  out.unmount()
})

await test('English copy comes from props.getLanguage and locale-aware day labels', async () => {
  const load = loadClient({ fetchImpl: fetchByDays(), lang: 'zh-CN' })
  const out = await mount(load, load.model.UsageSection, { t: undefined, getLanguage: () => 'en' })
  assert.ok(out.contains('Usage'))
  assert.ok(out.contains("Costs aren't shown"))
  assert.ok(out.contains('6 sessions'))
  assert.ok(out.contains('33.3% cache hits'))
  assert.ok(out.contains('Tokens per day'))
  assert.ok(out.contains('By model'))
  assert.ok(out.contains('Uncached input'))
  const ranges = out.buttons.filter((button) => ['7', '30', '90'].includes(button.props['data-value'])).map((button) => button.children.join(''))
  assert.deepEqual(ranges, ['7d', '30d', '90d'])
  const axisText = out.byTag('text').map((node) => node.children.join(''))
  assert.ok(axisText.includes('Oct 14'), 'english first day label')
  assert.ok(axisText.includes('Nov 12'), 'english last day label')
  out.unmount()

  // The same component in a Chinese document without getLanguage stays Chinese.
  const zhLoad = loadClient({ fetchImpl: fetchByDays(), lang: 'zh-CN' })
  const zhOut = await mount(zhLoad, zhLoad.model.UsageSection, { t: undefined })
  assert.ok(zhOut.contains('用量统计'))
  assert.ok(zhOut.contains('每日 Token'))
  zhOut.unmount()
})

await test('props.fetchReport from the slot inject is preferred over global fetch', async () => {
  const load = loadClient({ fetchImpl: () => Promise.reject(new Error('global fetch must not be used')) })
  const requested = []
  const injected = (days) => {
    requested.push(days)
    return Promise.resolve(load.model.parseReport(makeReport(days)))
  }
  const out = await mount(load, load.model.UsageSection, { t: undefined, fetchReport: injected })
  assert.deepEqual(requested, [30])
  assert.equal(load.fetchCalls.length, 0)
  assert.equal(out.byClass('us-card').length, 3)
  assert.equal(out.byClass('us-chart-wrap')[0].props['data-total'], '20130000')
  out.unmount()
})

await test('polls every 10 seconds while mounted and clears the interval', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  assert.equal(load.intervalCalls.length, 1)
  assert.equal(load.intervalCalls[0].ms, 10000)
  const intervalId = load.intervalCalls[0].id
  out.unmount()
  assert.ok(load.clearedIntervals.includes(intervalId), 'interval cleared on unmount')
})

await test('every request stays on the plugin route and asks for JSON', async () => {
  const load = loadClient({ fetchImpl: fetchByDays() })
  const out = await mount(load, load.model.UsageSection, { t: undefined })
  let next = await out.rerender()
  next.buttons.find((button) => button.props['data-value'] === '7').props.onClick()
  next = await out.rerender()
  next.byClass('us-refresh')[0].props.onClick()
  next = await out.rerender()
  assert.ok(load.fetchCalls.length >= 3)
  for (const call of load.fetchCalls) {
    assert.match(call.url, /^\/dsh-usage-stats\/report\?days=(7|30|90)$/, 'unexpected request ' + call.url)
    assert.equal(call.init.headers.accept, 'application/json')
  }
  assert.equal(load.fetchCalls.some((call) => /^https?:/i.test(call.url)), false, 'no absolute URLs')
  out.unmount()
})

await test('UsageHeader renders the range control and only fires on a change', async () => {
  const load = loadClient()
  const model = load.model
  const tr = model.textOf(undefined, true)
  const changes = []
  const out = await mount(load, model.UsageHeader, { tr, days: 7, onDays: (value) => changes.push(value) })
  const buttons = out.buttons
  assert.equal(buttons.length, 3)
  assert.deepEqual(buttons.map((button) => button.props['data-value']), ['7', '30', '90'])
  assert.deepEqual(buttons.map((button) => button.props['aria-pressed']), ['true', 'false', 'false'])
  assert.deepEqual(buttons.map((button) => button.children.join('')), ['7 天', '30 天', '90 天'])
  buttons[0].props.onClick()
  assert.deepEqual(changes, [], 'clicking the active range is a no-op')
  buttons[2].props.onClick()
  assert.deepEqual(changes, [90])
  out.unmount()
})

await test('UsageIcon draws the three bars and rising line', async () => {
  const load = loadClient()
  const out = await mount(load, load.model.UsageIcon, { size: 18 })
  const svg = out.byTag('svg')[0]
  assert.notEqual(svg, undefined)
  assert.equal(svg.props.width, 18)
  assert.equal(svg.props.height, 18)
  assert.equal(svg.props.className, 'us-icon')
  assert.equal(out.byTag('rect').length, 3)
  assert.equal(out.byTag('path').length, 1)
  out.unmount()
})

// --------------------------------------------------------------- summary

if (failures.length > 0) {
  console.error('\n' + failures.length + ' failed, ' + passed + ' passed')
  process.exitCode = 1
} else {
  console.log('\n' + passed + ' tests passed')
}