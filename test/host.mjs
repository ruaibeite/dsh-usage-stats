/**
 * Host-half tests for @ruaibeite/dsh-usage-stats.
 *
 * Plain Node (`node test/host.mjs`), zero dependencies, no Harness process and
 * no browser. Everything is driven through the exported pure functions and the
 * injectable filesystem seam in `buildIndex`, so the tests never touch the real
 * `$DSH_HOME/cache` (every test that writes uses `mkdtemp`).
 *
 * The last block uses this machine's real `~/.dsh` data read-only:
 *   1. incremental reuse on a copied set of real logs (deterministic),
 *   2. first full scan timing over every real session log,
 *   3. per-session totals parity against `storages/session_projcache` (the hard
 *      SPEC acceptance criterion).
 * If the real data is absent the block prints SKIP instead of failing.
 */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as host from '../index.js'

const {
  CATEGORIES,
  CACHE_RELATIVE_PATH,
  DEFAULT_RANGE_DAYS,
  INDEX_VERSION,
  RANGES,
  ROUTE,
  WARMUP_DELAY_MS,
  aggregateReport,
  apply,
  buildIndex,
  categoryOfTools,
  createIndexLoader,
  createReportHandler,
  currentTzOffsetMinutes,
  dayOfTime,
  decodeZstdFrames,
  discoverLogs,
  emptyIndex,
  foldLine,
  foldLines,
  foldSessionBuffer,
  foldSessionText,
  normalizeDays,
  parseIndex,
  rangeDays,
  scanZstdFrames,
  warmIndex,
} = host

// Tiny harness (same style as the sibling context-garden host tests).
let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL -', name)
    console.log(error && error.stack ? error.stack : String(error))
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok -', name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL -', name)
    console.log(error && error.stack ? error.stack : String(error))
  }
}
async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

// --------------------------------------------------------------- zstd helpers
function frameOf(chunk) {
  return zstdCompressSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}
function checksumFrameOf(chunk) {
  return zstdCompressSync(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
}

// ------------------------------------------------------------ event fixtures
const HEADER = JSON.stringify({
  type: 'session',
  version: 4,
  id: 'session-fixture',
  createdAt: 1700000000000,
  cwd: '/work/fixture',
})

function lineOf(value) {
  return JSON.stringify(value)
}
function eventLine(type, seq, time, data) {
  const event = { type, seq }
  if (time !== undefined) event.time = time
  if (data !== undefined) event.data = data
  return lineOf(event)
}
function usageObject(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  const usage = { inputTokens, outputTokens }
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
  return usage
}
function messageLine(options = {}) {
  const data = { turn: options.turn ?? 1, step: options.step ?? 1 }
  data.message = { role: 'assistant', content: [] }
  if (options.extraUsage !== undefined) data.stream = [{ type: 'chunk', chunk: { type: 'usage', usage: options.extraUsage } }]
  if (options.usage !== undefined) data.usage = options.usage
  if (options.source !== false) {
    data.source = { kind: 'model', provider: options.provider ?? 'provider-a', model: options.model ?? 'model-a' }
  }
  return eventLine('assistant/message', options.seq ?? 1, options.time ?? 1000, data)
}
function attemptLine(options = {}) {
  const stream = (options.usages ?? []).map((usage) => ({ type: 'chunk', chunk: { type: 'usage', usage } }))
  return eventLine('assistant/attempt', options.seq ?? 1, options.time ?? 1000, {
    turn: options.turn ?? 1,
    step: options.step ?? 1,
    stream,
  })
}
function routeLine(provider, model, seq = 1, time = 999) {
  return eventLine('request/context', seq, time, { provider, model })
}
function toolLine(name, seq = 1, time = 1000) {
  return eventLine('tool/call', seq, time, { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' })
}
function retryLine(turn, step, seq = 1, time = 1000) {
  return eventLine('llm/retry-started', seq, time, { retryId: 'retry-1', turn, step, retry: 1 })
}
function sessionText(lines, header = HEADER) {
  return [header, ...lines].join('\n')
}
function setOfTotals(folded) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const day of Object.values(folded.days)) {
    for (const values of Object.values(day.usage)) {
      totals.input += values[0]
      totals.output += values[1]
      totals.cacheRead += values[2]
      totals.cacheWrite += values[3]
    }
  }
  return totals
}
function totalsOfDays(days) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const day of Object.values(days)) {
    for (const values of Object.values(day.usage)) {
      totals.input += values[0]
      totals.output += values[1]
      totals.cacheRead += values[2]
      totals.cacheWrite += values[3]
    }
  }
  return totals
}

// --------------------------------------------------------------- fake context
function fakeContext(options = {}) {
  const effects = []
  const registrations = []
  const warnings = []
  const injections = []
  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
      error() {},
    },
  }
  if (options.effect !== false) {
    ctx.effect = (fn, label) => {
      const dispose = fn()
      effects.push({ dispose: typeof dispose === 'function' ? dispose : () => {}, label })
      return dispose
    }
  }
  if (options.inject !== false) {
    ctx.inject = (services, callback) => {
      injections.push(services)
      if (options.webServer === false) return
      callback(ctx)
    }
  }
  if (options.webServer !== false) {
    ctx.webServer = {
      register(definition) {
        registrations.push(definition)
        if (options.throwOnRegister !== undefined) throw options.throwOnRegister
        return () => {
          definition.disposed = true
        }
      },
    }
  }
  ctx.__effects = effects
  ctx.__registrations = registrations
  ctx.__warnings = warnings
  ctx.__injections = injections
  return ctx
}

/** Replace the process timers while `fn` runs; the plugin only uses them for warm-up. */
async function withFakeTimers(fn) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback, delay, args, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === 'object') timer.cleared = true
  }
  try {
    return await fn({ timers })
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}
function effectByLabel(ctx, label) {
  return ctx.__effects.find((effect) => effect.label === label)
}

function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: undefined,
    ended: 0,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.ended += 1
      this.body = body
    },
  }
}

// ------------------------------------------------------------------ temp home
async function makeTempHome() {
  return mkdtemp(path.join(os.tmpdir(), 'usage-stats-test-'))
}
async function writeSessionLog(home, id, text, options = {}) {
  const directory = path.join(home, 'sessions', options.cwdBox ?? 'cwd-a', id)
  await mkdir(directory, { recursive: true })
  const frameSize = options.frameSize
  let bytes
  if (options.plain) {
    bytes = Buffer.from(text)
    await writeFile(path.join(directory, 'session.v4.jsonl'), bytes)
    return { directory, file: path.join(directory, 'session.v4.jsonl') }
  }
  if (frameSize === undefined) {
    bytes = frameOf(text)
  } else {
    const chunks = []
    for (let index = 0; index < text.length; index += frameSize) chunks.push(frameOf(text.slice(index, index + frameSize)))
    bytes = Buffer.concat(chunks)
  }
  await writeFile(path.join(directory, 'session.v4.jsonl.zstd'), bytes)
  return { directory, file: path.join(directory, 'session.v4.jsonl.zstd') }
}

// ============================================================ export contract
test('the module exports the SPEC §4 contract', () => {
  assert.equal(ROUTE, '/dsh-usage-stats/report')
  assert.equal(INDEX_VERSION, 1)
  assert.deepEqual(RANGES, [7, 30, 90])
  assert.equal(DEFAULT_RANGE_DAYS, 30)
  assert.equal(WARMUP_DELAY_MS, 4000)
  assert.deepEqual(CATEGORIES, ['chat', 'cowork', 'code'])
  assert.equal(CACHE_RELATIVE_PATH, path.join('cache', 'usage-stats', 'index.json'))
  for (const name of [
    'scanZstdFrames', 'decodeZstdFrames', 'foldLine', 'foldLines', 'foldSessionText',
    'foldSessionBuffer', 'categoryOfTools', 'aggregateReport', 'parseIndex', 'emptyIndex',
    'discoverLogs', 'buildIndex', 'createReportHandler', 'createIndexLoader', 'warmIndex',
    'dayOfTime', 'rangeDays', 'normalizeDays', 'resolveDshHome', 'apply',
  ]) {
    assert.equal(typeof host[name], 'function', `${name} must be exported as a function`)
  }
})

// ============================================================ zstd frame scan
test('scanZstdFrames finds one complete frame and decodeZstdFrames returns its text', () => {
  const text = '{"type":"a"}\n{"type":"b"}\n'
  const buffer = frameOf(text)
  const result = scanZstdFrames(buffer)
  assert.equal(result.tornStart, undefined)
  assert.equal(result.frames.length, 1)
  assert.deepEqual(result.frames[0], { start: 0, end: buffer.length })
  assert.equal(decodeZstdFrames(buffer), text)
})

test('scanZstdFrames scans multiple concatenated frames (the real container layout)', () => {
  const first = frameOf('{"type":"a"}\n')
  const second = frameOf('{"type":"b"}\n')
  const third = frameOf('{"type":"c"}\n')
  const buffer = Buffer.concat([first, second, third])
  const { frames } = scanZstdFrames(buffer)
  assert.equal(frames.length, 3)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, first.length)
  assert.equal(frames[1].start, first.length)
  assert.equal(frames[2].end, buffer.length)
  assert.equal(decodeZstdFrames(buffer), '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n')
})

test('scanZstdFrames accepts checksummed frames and maxFrames limits the scan', () => {
  const first = checksumFrameOf('one\n')
  const second = checksumFrameOf('two\n')
  const buffer = Buffer.concat([first, second])
  assert.equal(scanZstdFrames(buffer).frames.length, 2)
  const limited = scanZstdFrames(buffer, 1)
  assert.equal(limited.frames.length, 1)
  assert.deepEqual(limited.frames[0], { start: 0, end: first.length })
  assert.equal(decodeZstdFrames(buffer), 'one\ntwo\n')
})

test('scanZstdFrames drops a torn tail (truncated final frame) instead of failing', () => {
  const first = frameOf('complete\n')
  const second = frameOf('torn tail that never finishes\n')
  const buffer = Buffer.concat([first, second.subarray(0, Math.max(4, second.length - 5))])
  const result = scanZstdFrames(buffer)
  assert.equal(result.frames.length, 1)
  assert.equal(result.tornStart, first.length)
  assert.equal(decodeZstdFrames(buffer), 'complete\n', 'the torn tail is not decoded')
})

test('scanZstdFrames reports a torn first frame with no complete frames', () => {
  const frame = frameOf('partial\n')
  const result = scanZstdFrames(frame.subarray(0, 6))
  assert.equal(result.frames.length, 0)
  assert.equal(result.tornStart, 0)
  assert.equal(scanZstdFrames(Buffer.alloc(0)).frames.length, 0)
  assert.equal(scanZstdFrames(Buffer.from([1, 2])).tornStart, 0)
})

test('scanZstdFrames throws on bad magic and requires a Buffer', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('this is definitely not a zstd container')), /invalid frame magic/)
  assert.throws(() => scanZstdFrames('not a buffer'), /expects a Buffer/)
})

test('decodeZstdFrames joins multi-byte UTF-8 split across frames', () => {
  const text = '你好\n世界'
  const bytes = Buffer.from(text)
  const split = 4 // inside/next to a 3-byte character
  const buffer = Buffer.concat([frameOf(bytes.subarray(0, split)), frameOf(bytes.subarray(split))])
  assert.equal(scanZstdFrames(buffer).frames.length, 2)
  assert.equal(decodeZstdFrames(buffer), text)
})

test('foldSessionBuffer(frames) equals foldSessionText(plaintext)', () => {
  const text = sessionText([
    routeLine('provider-a', 'model-a', 1, 1000),
    messageLine({ usage: usageObject(10, 2, 100, 0), time: 1000 }),
    toolLine('bash', 2, 1001),
  ])
  const plain = foldSessionText(text)
  const framed = foldSessionBuffer(frameOf(text))
  assert.deepEqual(framed.days, plain.days)
  assert.deepEqual(framed.totals, plain.totals)
  assert.equal(framed.category, 'code')
})

// ================================================================ event folds
test('assistant/message records the first usage object, header fields and source model', () => {
  const folded = foldSessionText(sessionText([
    routeLine('route-provider', 'route-model', 1, 900),
    messageLine({
      usage: { outputTokens: 7, totalTokens: 107, inputTokens: 100 }, // field order variant
      provider: 'provider-a',
      model: 'model-a',
      time: 1000,
    }),
  ]))
  assert.deepEqual(folded.totals, { input: 100, output: 7, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(folded.providers, { 'model-a': ['provider-a'] })
  assert.deepEqual(folded.models, ['model-a'])
  assert.equal(folded.createdAt, 1700000000000)
  assert.equal(folded.cwd, '/work/fixture')
  assert.equal(folded.category, 'chat')
})

test('assistant/message with two usage objects counts only the first (data usage before stream chunk)', () => {
  const folded = foldSessionText(sessionText([
    messageLine({
      usage: usageObject(10, 2, 100),
      extraUsage: usageObject(10, 2, 100), // stream chunk repeats the same sample
      time: 1000,
    }),
  ]))
  assert.deepEqual(folded.totals, { input: 10, output: 2, cacheRead: 100, cacheWrite: 0 })
})

test('assistant/message without its own usage falls back to the last streamed usage chunk', () => {
  const folded = foldSessionText(sessionText([
    messageLine({
      extraUsage: usageObject(11, 3, 700, 2), // no data.usage: only the stream carries usage
      time: 1000,
    }),
  ]))
  assert.deepEqual(folded.totals, { input: 11, output: 3, cacheRead: 700, cacheWrite: 2 })
})

test('assistant/attempt takes the last usage chunk and the last request route as its model', () => {
  const folded = foldSessionText(sessionText([
    routeLine('provider-a', 'model-a', 1, 900),
    attemptLine({
      usages: [usageObject(5, 1), usageObject(40, 9, 500, 3)],
      time: 1000,
    }),
  ]))
  assert.deepEqual(folded.totals, { input: 40, output: 9, cacheRead: 500, cacheWrite: 3 })
  assert.deepEqual(folded.providers, { 'model-a': ['provider-a'] })
})

test('model source falls back to the last request route, then to an explicit unknown model', () => {
  const routed = foldSessionText(sessionText([
    routeLine('provider-r', 'model-r', 1, 900),
    messageLine({ usage: usageObject(3, 1), source: false, time: 1000 }),
  ]))
  assert.deepEqual(routed.providers, { 'model-r': ['provider-r'] })

  const unknownMessage = foldSessionText(sessionText([
    messageLine({ usage: usageObject(4, 1), source: false, time: 1000 }),
  ]))
  assert.deepEqual(unknownMessage.totals, { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(unknownMessage.providers, { unknown: [] })
  assert.deepEqual(unknownMessage.models, ['unknown'])

  const unknownAttempt = foldSessionText(sessionText([attemptLine({ usages: [usageObject(6, 2)], time: 1000 })]))
  assert.deepEqual(unknownAttempt.totals.input, 6)
  assert.deepEqual(unknownAttempt.providers, { unknown: [] })
})

test('same turn+step replaces the previous sample instead of adding to it', () => {
  const folded = foldSessionText(sessionText([
    messageLine({ usage: usageObject(10, 1), time: 1000 }),
    messageLine({ usage: usageObject(30, 3), time: 1001 }),
  ]))
  assert.deepEqual(folded.totals, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0 })
})

test('different turn+step accumulates both samples', () => {
  const folded = foldSessionText(sessionText([
    messageLine({ usage: usageObject(10, 1), turn: 1, step: 1, time: 1000 }),
    messageLine({ usage: usageObject(20, 2), turn: 1, step: 2, time: 1001 }),
    messageLine({ usage: usageObject(40, 4), turn: 2, step: 1, time: 1002 }),
  ]))
  assert.deepEqual(folded.totals, { input: 70, output: 7, cacheRead: 0, cacheWrite: 0 })
})

test('llm/retry-started clears the replacement slot for the same turn+step', () => {
  const folded = foldSessionText(sessionText([
    attemptLine({ usages: [usageObject(10, 1)], turn: 3, step: 4, time: 1000 }),
    retryLine(3, 4, 2, 1000),
    messageLine({ usage: usageObject(20, 2, 200), turn: 3, step: 4, time: 1001 }),
  ]))
  // The failed attempt is kept and the retried message accumulates too.
  assert.deepEqual(folded.totals, { input: 30, output: 3, cacheRead: 200, cacheWrite: 0 })
})

test('llm/retry-started for a different turn+step keeps the replacement slot', () => {
  const folded = foldSessionText(sessionText([
    attemptLine({ usages: [usageObject(10, 1)], turn: 1, step: 1, time: 1000 }),
    retryLine(2, 2, 2, 1000), // unrelated attempt does not clear turn 1/step 1
    messageLine({ usage: usageObject(50, 5), turn: 1, step: 1, time: 1001 }),
  ]))
  assert.deepEqual(folded.totals, { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 })
})

test('request/context and request/header update the fallback route', () => {
  const headerRoute = eventLine('request/header', 1, 900, {
    header: { config: { provider: 'header-provider', model: 'header-model' } },
  })
  const folded = foldSessionText(sessionText([
    headerRoute,
    messageLine({ usage: usageObject(2, 1), source: false, time: 1000 }),
    routeLine('late-provider', 'late-model', 2, 1001),
    messageLine({ usage: usageObject(5, 1), source: false, turn: 1, step: 2, time: 1002 }),
  ]))
  assert.deepEqual(folded.providers, {
    'header-model': ['header-provider'],
    'late-model': ['late-provider'],
  })
})

test('usage validation ignores unusable samples without throwing', () => {
  const variants = [
    { inputTokens: 'nope', outputTokens: 2 },
    { inputTokens: 3 },
    { inputTokens: null, outputTokens: 2 },
    { cacheReadTokens: 10 },
  ]
  for (const usage of variants) {
    const folded = foldSessionText(sessionText([messageLine({ usage, time: 1000 })]))
    assert.deepEqual(folded.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
  assert.doesNotThrow(() => foldSessionText('not json at all\n{"type":"tool/result","seq":1,"time":1}\n'))
})

test('tool/call classifies code and team tools and counts web searches with model attribution', () => {
  const folded = foldSessionText(sessionText([
    toolLine('web_search', 1, 1000), // no model yet -> unknown attribution
    messageLine({ usage: usageObject(1, 1), provider: 'provider-w', model: 'model-w', time: 1001 }),
    toolLine('web_fetch', 2, 1002), // attributed to model-w
    toolLine('bash', 3, 1003),
    toolLine('spawn_teammate', 4, 1004),
  ]))
  assert.equal(folded.category, 'cowork', 'team tool wins over code tool')
  assert.equal(folded.hasCode, true)
  assert.equal(folded.hasTeam, true)
  assert.equal(folded.webSearches, 2)
  const day = Object.values(folded.days)[0]
  assert.equal(day.web, 2)
  assert.equal(day.webByModel.unknown, 1)
  assert.equal(day.webByModel['model-w'], 1)
})

test('categoryOfTools classifies single names and iterables, cowork wins over code', () => {
  assert.equal(categoryOfTools(['read', 'glob']), 'chat')
  assert.equal(categoryOfTools(['bash']), 'code')
  assert.equal(categoryOfTools(['job_kill']), 'code')
  assert.equal(categoryOfTools(['spawn_teammate']), 'cowork')
  assert.equal(categoryOfTools(['bash', 'team_task_list']), 'cowork')
  assert.equal(categoryOfTools(new Set(['write', 'wait_agent'])), 'cowork')
  assert.equal(categoryOfTools('run_code'), 'code')
  assert.equal(categoryOfTools([]), 'chat')
  assert.equal(categoryOfTools(null), 'chat')
  assert.equal(categoryOfTools([42, null, undefined]), 'chat')
  // Every tool listed in SPEC §4.1 must classify as code.
  for (const name of ['bash', 'pwsh', 'run_code', 'terminal', 'shell', 'exec', 'write', 'edit',
    'apply_patch', 'str_replace_editor', 'fs_write', 'fs_edit', 'notebook_edit', 'jobs', 'job_kill',
    'workflow', 'ralph', 'plugin_manager', 'worktree']) {
    assert.equal(categoryOfTools([name]), 'code', `${name} should be code`)
  }
  for (const name of ['spawn_teammate', 'send_message', 'team_task_list', 'list_agents', 'wait_agent', 'interrupt_agent']) {
    assert.equal(categoryOfTools([name]), 'cowork', `${name} should be cowork`)
  }
})

test('session header createdAt/cwd are decoded, including escaped and non-ASCII paths', () => {
  const header = lineOf({
    type: 'session',
    version: 4,
    id: 'session-fixture',
    createdAt: 123456789,
    cwd: '/tmp/中文 "quoted" path',
  })
  const folded = foldSessionText(sessionText([], header))
  assert.equal(folded.createdAt, 123456789)
  assert.equal(folded.cwd, '/tmp/中文 "quoted" path')
})

test('events without a time field fall back to the previous event time (time may be missing)', () => {
  const noTime = JSON.stringify({
    type: 'assistant/message',
    seq: 2,
    data: { turn: 1, step: 2, usage: usageObject(9, 3), message: { role: 'assistant', content: [] } },
  })
  const folded = foldSessionText(sessionText([
    messageLine({ usage: usageObject(10, 2), time: 1700000000000 }),
    noTime,
  ]))
  assert.deepEqual(folded.totals, { input: 19, output: 5, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(Object.keys(folded.days), [dayOfTime(1700000000000, currentTzOffsetMinutes())])
})

test('date buckets use the supplied tz offset instead of the process timezone', () => {
  const timestamp = Date.UTC(2026, 0, 1, 0, 30) // 00:30 UTC on 2026-01-01
  const text = sessionText([messageLine({ usage: usageObject(10, 2), time: timestamp })])
  assert.deepEqual(Object.keys(foldSessionText(text, { tzOffsetMinutes: 480 }).days), ['2026-01-01'])
  assert.deepEqual(Object.keys(foldSessionText(text, { tzOffsetMinutes: -300 }).days), ['2025-12-31'])
})

test('foldLines and foldLine are usable directly and ignore junk lines', () => {
  const state = { headerSeen: false, createdAt: 0, cwd: null, lastTime: 0, records: [], last: null, route: null, lastModel: null, hasCode: false, hasTeam: false }
  foldLine(state, '')
  foldLine(state, null)
  foldLine(state, 'garbage')
  foldLine(state, HEADER)
  assert.equal(state.headerSeen, true)
  assert.equal(state.createdAt, 1700000000000)
  const folded = foldLines([HEADER, messageLine({ usage: usageObject(1, 2), time: 1000 })])
  assert.deepEqual(folded.totals, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
})

// ============================================================ time/range pure
test('dayOfTime applies the offset as a fixed local shift and rejects bad input', () => {
  assert.equal(dayOfTime(Date.UTC(2026, 0, 1, 0, 30), 480), '2026-01-01')
  assert.equal(dayOfTime(Date.UTC(2026, 0, 1, 0, 30), -300), '2025-12-31')
  assert.equal(dayOfTime(Date.UTC(2026, 0, 1, 20, 0), 480), '2026-01-02')
  assert.equal(dayOfTime(Date.UTC(2026, 0, 1, 20, 0), 0), '2026-01-01')
  assert.equal(dayOfTime(Number.NaN, 480), null)
  assert.equal(dayOfTime(undefined, 480), null)
})

test('rangeDays returns an ascending inclusive range ending on the local today', () => {
  const now = Date.UTC(2026, 0, 1, 12) // 20:00 local at +480
  const seven = rangeDays(7, now, 480)
  assert.equal(seven.list.length, 7)
  assert.equal(seven.to, '2026-01-01')
  assert.equal(seven.from, '2025-12-26')
  assert.deepEqual([...seven.list].sort(), seven.list)
  assert.equal(rangeDays(30, now, 480).list.length, 30)
  assert.equal(rangeDays(90, now, 480).list.length, 90)
  assert.equal(rangeDays(30, now, 480).list.at(-1), '2026-01-01')
  // The local day, not the UTC day, decides the range end.
  const late = rangeDays(1, Date.UTC(2026, 0, 1, 23, 30), -300)
  assert.equal(late.to, '2026-01-01')
})

test('normalizeDays accepts 7/30/90 and falls back to 30 for anything else', () => {
  assert.equal(normalizeDays(7), 7)
  assert.equal(normalizeDays('30'), 30)
  assert.equal(normalizeDays(90), 90)
  assert.equal(normalizeDays('90'), 90)
  for (const bad of [undefined, null, '', 'abc', 0, 1, 45, 365, -7, Number.NaN]) {
    assert.equal(normalizeDays(bad), 30, `normalizeDays(${String(bad)}) should fall back`)
  }
})

// ================================================================= index cache
test('emptyIndex and parseIndex round-trip and reject foreign versions/timezones', () => {
  const empty = emptyIndex(480, 1700000000000)
  assert.deepEqual(empty, { version: 1, tzOffsetMinutes: 480, createdAt: 1700000000000, sessions: {} })
  assert.deepEqual(parseIndex(JSON.parse(JSON.stringify(empty)), 480), empty)
  assert.equal(parseIndex(empty, 0), null, 'a different timezone invalidates the whole cache')
  assert.equal(parseIndex({ ...empty, version: 2 }), null)
  assert.equal(parseIndex(null), null)
  assert.equal(parseIndex([]), null)
  assert.equal(parseIndex('nope'), null)
  assert.equal(parseIndex({ ...empty, tzOffsetMinutes: undefined }), null)
})

test('parseIndex keeps fractional mtimeMs (incremental reuse regression) and drops corrupt entries', () => {
  const entry = {
    file: '/sessions/x/session.v4.jsonl.zstd',
    size: 10,
    mtimeMs: 1793322368981.5317, // stat() mtime is fractional on macOS
    createdAt: 1,
    cwd: '/work',
    category: 'code',
    models: ['m1', 'm1', 42],
    providers: { m1: ['p2', 'p1', 'p1', 7] },
    days: {
      '2026-01-01': { usage: { m1: [1, 2, 3, 4, 'x'] }, web: 1, webByModel: { m1: 1, bad: -1 } },
      'not-a-day': { usage: {} },
    },
  }
  const index = {
    version: 1,
    tzOffsetMinutes: 480,
    createdAt: 5,
    sessions: {
      'session-a': entry,
      'session-bad': { file: '', size: 1, mtimeMs: 1, createdAt: 1, category: 'chat', models: [], providers: {}, days: {} },
      'session-array': [],
    },
  }
  const parsed = parseIndex(JSON.parse(JSON.stringify(index)), 480)
  assert.deepEqual(Object.keys(parsed.sessions), ['session-a'])
  assert.equal(parsed.sessions['session-a'].mtimeMs, 1793322368981.5317, 'mtimeMs must keep its fraction')
  assert.deepEqual(parsed.sessions['session-a'].models, ['m1'])
  assert.deepEqual(parsed.sessions['session-a'].providers, { m1: ['p1', 'p2'] })
  assert.deepEqual(parsed.sessions['session-a'].days['2026-01-01'].usage.m1, [1, 2, 3, 4])
  assert.deepEqual(parsed.sessions['session-a'].days['2026-01-01'].webByModel, { m1: 1 })
})

// ------------------------------------------------------------- fake filesystem
function fakeFileSystem() {
  const files = new Map() // absolute path -> { buffer, size, mtimeMs, failRead }
  const counters = { writes: 0, renames: 0, mkdirs: 0 }
  const api = {
    files,
    counters,
    addFile(file, buffer, mtimeMs = 1000) {
      const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
      files.set(file, { buffer: data, size: data.length, mtimeMs })
    },
    removeFile(file) {
      files.delete(file)
    },
    failReads: new Set(),
    async readdir(directory) {
      const prefix = `${directory}/`
      const entries = new Map()
      let found = false
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue
        found = true
        const rest = file.slice(prefix.length)
        const segment = rest.split('/')[0]
        if (rest.includes('/')) entries.set(segment, { name: segment, isDirectory: () => true, isFile: () => false })
        else entries.set(segment, { name: segment, isDirectory: () => false, isFile: () => true })
      }
      if (!found) throw Object.assign(new Error(`ENOENT: ${directory}`), { code: 'ENOENT' })
      return [...entries.values()]
    },
    async stat(file) {
      const entry = files.get(file)
      if (!entry) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return { size: entry.size, mtimeMs: entry.mtimeMs }
    },
    async readFile(file, encoding) {
      if (api.failReads.has(file)) throw new Error(`EACCES: ${file}`)
      const entry = files.get(file)
      if (!entry) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return encoding === 'utf8' ? entry.buffer.toString('utf8') : entry.buffer
    },
    async writeFile(file, data) {
      counters.writes += 1
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      files.set(file, { buffer, size: buffer.length, mtimeMs: 2000 + counters.writes })
    },
    async mkdir() {
      counters.mkdirs += 1
    },
    async rename(from, to) {
      counters.renames += 1
      const entry = files.get(from)
      if (!entry) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, entry)
    },
    async rm(file) {
      files.delete(file)
    },
  }
  return api
}
function buildOptionsFor(fs, overrides = {}) {
  return {
    dshHome: '/fake',
    sessionsRoot: '/sessions',
    cacheFile: '/cache/usage-stats/index.json',
    tzOffsetMinutes: 480,
    now: () => 1000,
    readFile: fs.readFile,
    readdir: fs.readdir,
    stat: fs.stat,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    rename: fs.rename,
    rm: fs.rm,
    ...overrides,
  }
}
function logText(id, options = {}) {
  const time = options.time ?? 1000
  return sessionText([
    routeLine('provider-a', 'model-a', 1, time - 1),
    messageLine({ usage: usageObject(options.input ?? 10, options.output ?? 2, options.cacheRead ?? 100), time }),
  ], lineOf({ type: 'session', version: 4, id, createdAt: time - 10, cwd: '/work/x' }))
}
const SESSION_LOG_A = '/sessions/cwd-a/session-aaa/session.v4.jsonl.zstd'
const SESSION_LOG_B = '/sessions/cwd-a/session-bbb/session.v4.jsonl.zstd'
const FAKE_CACHE = '/cache/usage-stats/index.json'

await testAsync('discoverLogs finds nested compressed and plaintext logs and prefers .zstd on collisions', async () => {
  const fs = fakeFileSystem()
  fs.addFile(SESSION_LOG_A, frameOf('a'))
  fs.addFile(SESSION_LOG_B, frameOf('b'))
  fs.addFile('/sessions/cwd-a/session-ccc/session.v4.jsonl', Buffer.from(logText('session-ccc')))
  fs.addFile('/sessions/cwd-a/session-ddd/other.txt', Buffer.from('ignore me'))
  fs.addFile('/sessions/cwd-a/session-eee/session.v4.jsonl', Buffer.from('old plaintext'))
  fs.addFile('/sessions/cwd-a/session-eee/session.v4.jsonl.zstd', frameOf('new compressed'))
  const logs = await discoverLogs('/sessions', { readdir: fs.readdir })
  assert.equal(logs.length, 4)
  assert.deepEqual(logs.map((log) => log.id).sort(), ['session-aaa', 'session-bbb', 'session-ccc', 'session-eee'])
  const collision = logs.find((log) => log.id === 'session-eee')
  assert.ok(collision.file.endsWith('.jsonl.zstd'), 'compressed log wins over plaintext for the same session')
  assert.deepEqual(await discoverLogs('/sessions/missing', { readdir: fs.readdir }), [])
})

await testAsync('buildIndex scans, reuses by size+mtimeMs, rebuilds on changes and drops deleted sessions', async () => {
  const fs = fakeFileSystem()
  fs.addFile(SESSION_LOG_A, frameOf(logText('session-aaa', { input: 10, output: 2, cacheRead: 100 })), 1000.5)
  fs.addFile(SESSION_LOG_B, Buffer.concat([
    frameOf(`${HEADER}\n`),
    frameOf(`${messageLine({ usage: usageObject(5, 1, 50), time: 2000 })}\n`),
  ]), 2000)
  const options = buildOptionsFor(fs)

  const first = await buildIndex(options)
  assert.deepEqual(first.stats, { sessions: 2, scanned: 2, reused: 0, skipped: 0, files: 2, removed: 0 })
  assert.equal(first.wroteCache, true)
  assert.equal(first.writeError, null)
  assert.equal(fs.counters.writes, 1)
  assert.equal(fs.counters.renames, 1)
  assert.equal(fs.files.has(FAKE_CACHE), true)
  assert.equal([...fs.files.keys()].some((file) => file.endsWith('.tmp')), false, 'atomic write leaves no temp file')
  const stored = JSON.parse(await fs.readFile(FAKE_CACHE, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.tzOffsetMinutes, 480)
  assert.deepEqual(Object.keys(stored.sessions).sort(), ['session-aaa', 'session-bbb'])

  const second = await buildIndex(options)
  assert.deepEqual(second.stats, { sessions: 2, scanned: 0, reused: 2, skipped: 0, files: 2, removed: 0 })
  assert.equal(second.wroteCache, false, 'no change must not rewrite the cache')
  assert.equal(fs.counters.writes, 1)
  assert.equal(second.buildMs, 0)
  assert.equal(second.index.sessions['session-aaa'].mtimeMs, 1000.5, 'fractional mtimeMs survives the cache round-trip')

  // Touch one log (same content, new size+mtime) -> only that file rescans.
  fs.addFile(SESSION_LOG_B, Buffer.concat([
    frameOf(`${HEADER}\n`),
    frameOf(`${messageLine({ usage: usageObject(7, 3, 70), time: 2000 })}\n`),
  ]), 3000)
  const third = await buildIndex(options)
  assert.equal(third.stats.scanned, 1)
  assert.equal(third.stats.reused, 1)
  assert.equal(third.wroteCache, true)

  // Delete a log -> its session disappears from the index.
  fs.removeFile(SESSION_LOG_B)
  const fourth = await buildIndex(options)
  assert.deepEqual(Object.keys(fourth.index.sessions), ['session-aaa'])
  assert.equal(fourth.stats.removed, 1)
  assert.equal(fourth.wroteCache, true)

  // Timezone change -> whole index rebuilds even though files are unchanged.
  fs.addFile(SESSION_LOG_B, frameOf(logText('session-bbb')), 4000)
  await buildIndex(options)
  const retimed = await buildIndex({ ...options, tzOffsetMinutes: -300 })
  assert.equal(retimed.stats.reused, 0)
  assert.equal(retimed.stats.scanned, 2)
  assert.equal(retimed.index.tzOffsetMinutes, -300)
})

await testAsync('buildIndex skips corrupt and unreadable logs, survives a corrupt cache, and folds plaintext .jsonl', async () => {
  const fs = fakeFileSystem()
  fs.addFile(SESSION_LOG_A, frameOf(logText('session-aaa')))
  fs.addFile('/sessions/cwd-a/session-bad/session.v4.jsonl.zstd', Buffer.from('garbage not zstd'), 1000)
  fs.addFile('/sessions/cwd-a/session-denied/session.v4.jsonl.zstd', frameOf(logText('session-denied')), 1000)
  fs.failReads.add('/sessions/cwd-a/session-denied/session.v4.jsonl.zstd')
  fs.addFile('/sessions/cwd-a/session-plain/session.v4.jsonl', Buffer.from(logText('session-plain', { input: 4, output: 1, cacheRead: 0 })), 500)
  const options = buildOptionsFor(fs)
  const built = await buildIndex(options)
  assert.deepEqual(built.stats, { sessions: 2, scanned: 2, reused: 0, skipped: 2, files: 4, removed: 0 })
  assert.deepEqual(Object.keys(built.index.sessions).sort(), ['session-aaa', 'session-plain'])
  assert.deepEqual(totalsOfDays(built.index.sessions['session-plain'].days), { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 })

  // Corrupt cache JSON must be treated as absent, not throw.
  fs.addFile(FAKE_CACHE, Buffer.from('{ not json'), 9000)
  const rebuilt = await buildIndex(options)
  assert.equal(rebuilt.stats.scanned, 2)
  assert.equal(rebuilt.stats.reused, 0)
  assert.equal(rebuilt.wroteCache, true)
})

// --------------------------------------------------- real filesystem, fake data
await testAsync('buildIndex writes an atomic cache on disk and reuses it on the next build', async () => {
  const home = await makeTempHome()
  try {
    const text = logText('session-real', { input: 12, output: 3, cacheRead: 120 })
    await writeSessionLog(home, 'session-real', text)
    const cacheFile = path.join(home, CACHE_RELATIVE_PATH)
    const first = await buildIndex({ dshHome: home })
    assert.equal(first.stats.files, 1)
    assert.equal(first.stats.scanned, 1)
    assert.equal(first.wroteCache, true)
    assert.equal(existsSync(cacheFile), true)
    const directoryFiles = await readdir(path.dirname(cacheFile))
    assert.deepEqual(directoryFiles, ['index.json'], 'temp file is renamed away')
    const stored = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.sessions['session-real'].file, path.join(home, 'sessions', 'cwd-a', 'session-real', 'session.v4.jsonl.zstd'))

    const second = await buildIndex({ dshHome: home })
    assert.equal(second.stats.reused, 1)
    assert.equal(second.stats.scanned, 0)
    assert.equal(second.wroteCache, false)
    assert.ok(second.buildMs < 200, `incremental real-fs build should be < 200 ms, was ${second.buildMs} ms`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await testAsync('buildIndex handles a missing sessions directory as an empty index', async () => {
  const home = await makeTempHome()
  try {
    const built = await buildIndex({ dshHome: home })
    assert.deepEqual(built.stats, { sessions: 0, scanned: 0, reused: 0, skipped: 0, files: 0, removed: 0 })
    assert.deepEqual(built.index.sessions, {})
    assert.equal(built.tzOffsetMinutes, undefined, 'build result has no tz field; the index carries it')
    assert.equal(built.index.tzOffsetMinutes, currentTzOffsetMinutes())
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ============================================================== report/fixture
const REPORT_NOW = Date.UTC(2026, 0, 3, 12) // 20:00 local at +480 -> local 2026-01-03

function fixtureIndex() {
  return {
    version: 1,
    tzOffsetMinutes: 480,
    createdAt: 100,
    sessions: {
      'session-a': {
        file: '/a', size: 1, mtimeMs: 1.5, createdAt: 1, cwd: '/w',
        category: 'code',
        models: ['model-b', 'model-a'],
        providers: { 'model-a': ['provider-a'], 'model-b': ['provider-b'] },
        days: {
          '2026-01-01': { usage: { 'model-a': [10, 2, 100, 0], 'model-b': [5, 1, 0, 0] }, web: 2, webByModel: { 'model-a': 2 } },
          '2026-01-03': { usage: { 'model-a': [7, 1, 0, 0] }, web: 0, webByModel: {} },
          '2025-12-01': { usage: { 'model-a': [999, 999, 999, 0] }, web: 0, webByModel: {} },
        },
      },
      'session-b': {
        file: '/b', size: 1, mtimeMs: 2, createdAt: 2, cwd: null,
        category: 'cowork',
        models: ['model-a'],
        providers: { 'model-a': ['provider-a', 'provider-c'] },
        days: { '2026-01-02': { usage: { 'model-a': [1, 1, 10, 0] }, web: 0, webByModel: {} } },
      },
      'session-c': {
        file: '/c', size: 1, mtimeMs: 3, createdAt: 3, cwd: null,
        category: 'chat', models: [], providers: {}, days: {},
      },
    },
  }
}

test('aggregateReport zero-fills every day, filters the range and aggregates categories', () => {
  const report = aggregateReport(fixtureIndex(), { days: 7, now: REPORT_NOW })
  assert.equal(report.ok, true)
  assert.equal(report.days, 7)
  assert.deepEqual(report.range, { from: '2025-12-28', to: '2026-01-03' })
  assert.equal(report.tzOffsetMinutes, 480)
  assert.equal(report.daily.length, 7)
  assert.deepEqual(report.daily.map((row) => row.day), [
    '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03',
  ])
  const jan1 = report.daily.find((row) => row.day === '2026-01-01')
  assert.deepEqual(jan1.categories.code, { input: 15, output: 3, cacheRead: 100, cacheWrite: 0 })
  assert.deepEqual(jan1.categories.chat, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(jan1.models['model-a'], { input: 10, output: 2, cacheRead: 100, cacheWrite: 0 })
  assert.deepEqual(jan1.models['model-b'], { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 })
  const empty = report.daily.find((row) => row.day === '2025-12-31')
  assert.deepEqual(empty.models, {}, 'days without data keep a zero-filled category row and no models')

  assert.deepEqual(report.categories.code, { input: 22, output: 4, cacheRead: 100, cacheWrite: 0, webSearches: 2, sessions: 1 })
  assert.deepEqual(report.categories.cowork, { input: 1, output: 1, cacheRead: 10, cacheWrite: 0, webSearches: 0, sessions: 1 })
  assert.deepEqual(report.categories.chat, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 })
  assert.deepEqual(report.totals, {
    input: 23, output: 5, cacheRead: 110, cacheWrite: 0, webSearches: 2, sessions: 2,
  })
})

test('aggregateReport merges providers, sorts models by input+output and counts sessions per model', () => {
  const report = aggregateReport(fixtureIndex(), { days: 7, now: REPORT_NOW })
  assert.deepEqual(report.models.map((row) => row.model), ['model-a', 'model-b'])
  const modelA = report.models[0]
  assert.deepEqual(modelA.providers, ['provider-a', 'provider-c'])
  assert.deepEqual(modelA, {
    model: 'model-a',
    providers: ['provider-a', 'provider-c'],
    input: 18,
    output: 4,
    cacheRead: 110,
    cacheWrite: 0,
    webSearches: 2,
    sessions: 2,
  })
  assert.deepEqual(report.models[1], {
    model: 'model-b',
    providers: ['provider-b'],
    input: 5,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    webSearches: 0,
    sessions: 1,
  })
})

test('aggregateReport supports every range and defaults invalid/missing days to 30', () => {
  for (const days of [7, 30, 90]) {
    const report = aggregateReport(fixtureIndex(), { days, now: REPORT_NOW })
    assert.equal(report.days, days)
    assert.equal(report.daily.length, days)
    assert.equal(report.daily.at(-1).day, '2026-01-03')
  }
  for (const bad of [undefined, null, '0', 45, 'oodles']) {
    assert.equal(aggregateReport(fixtureIndex(), { days: bad, now: REPORT_NOW }).days, 30)
  }
  // 90 days reaches back into December data that the 7-day window excludes.
  assert.ok(aggregateReport(fixtureIndex(), { days: 90, now: REPORT_NOW }).totals.input > 23)
})

test('aggregateReport is defensive about missing/corrupt index data', () => {
  for (const bad of [null, undefined, 'nope', [], { version: 1, tzOffsetMinutes: 480, sessions: 'garbage' }]) {
    const report = aggregateReport(bad, { days: 7, now: REPORT_NOW })
    assert.equal(report.ok, true)
    assert.deepEqual(report.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 })
    assert.deepEqual(report.models, [])
    assert.equal(report.daily.length, 7)
    assert.deepEqual(report.index, { sessions: 0, scanned: 0, reused: 0, skipped: 0, files: 0 })
  }
  const stats = { sessions: 9, scanned: 2, reused: 7, skipped: 1, files: 10 }
  const report = aggregateReport(fixtureIndex(), { days: 7, now: REPORT_NOW, stats, buildMs: 8, generatedAt: 123 })
  assert.deepEqual(report.index, stats)
  assert.equal(report.buildMs, 8)
  assert.equal(report.generatedAt, 123)
})

test('aggregateReport uses the index timezone when none is injected and handles tz boundaries', () => {
  const report = aggregateReport(fixtureIndex(), { days: 7, now: REPORT_NOW })
  assert.equal(report.tzOffsetMinutes, 480)
  const shifted = aggregateReport(fixtureIndex(), { days: 7, now: Date.UTC(2026, 0, 3, 20), tzOffsetMinutes: -300 })
  assert.equal(shifted.days, 7)
  assert.equal(shifted.range.to, '2026-01-03')
})

// ================================================================== HTTP route
function reportFixtureBuild() {
  return {
    index: fixtureIndex(),
    stats: { sessions: 3, scanned: 0, reused: 3, skipped: 0, files: 3 },
    buildMs: 8,
  }
}

await testAsync('GET /dsh-usage-stats/report serves the frozen §4.3 payload shape', async () => {
  let builds = 0
  const handler = createReportHandler({
    loadIndex: async () => {
      builds += 1
      return reportFixtureBuild()
    },
    now: () => 1794000000000,
  })
  const response = fakeResponse()
  await handler({ method: 'GET', url: `${ROUTE}?days=7` }, response)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(builds, 1)
  const report = JSON.parse(response.body)
  assert.deepEqual(Object.keys(report).sort(), [
    'buildMs', 'categories', 'daily', 'days', 'generatedAt', 'index', 'models', 'ok', 'range', 'totals', 'tzOffsetMinutes',
  ])
  assert.equal(report.ok, true)
  assert.equal(report.days, 7)
  assert.equal(report.generatedAt, 1794000000000)
  assert.equal(report.buildMs, 8)
  assert.deepEqual(Object.keys(report.range).sort(), ['from', 'to'])
  assert.deepEqual(Object.keys(report.index).sort(), ['files', 'reused', 'scanned', 'sessions', 'skipped'])
  assert.deepEqual(report.index, { sessions: 3, scanned: 0, reused: 3, skipped: 0, files: 3 })
  assert.deepEqual(Object.keys(report.categories).sort(), ['chat', 'code', 'cowork'])
  const categoryKeys = ['cacheRead', 'cacheWrite', 'input', 'output', 'sessions', 'webSearches']
  for (const category of CATEGORIES) assert.deepEqual(Object.keys(report.categories[category]).sort(), categoryKeys)
  assert.deepEqual(Object.keys(report.totals).sort(), categoryKeys)
  for (const row of report.models) {
    assert.deepEqual(Object.keys(row).sort(), ['cacheRead', 'cacheWrite', 'input', 'model', 'output', 'providers', 'sessions', 'webSearches'])
  }
  for (const row of report.daily) {
    assert.deepEqual(Object.keys(row).sort(), ['categories', 'day', 'models'])
    for (const category of CATEGORIES) {
      assert.deepEqual(Object.keys(row.categories[category]).sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
    }
    for (const model of Object.values(row.models)) {
      assert.deepEqual(Object.keys(model).sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
    }
  }
})

await testAsync('HEAD returns the same status/headers without a body, other methods are 405', async () => {
  let builds = 0
  const handler = createReportHandler({
    loadIndex: async () => {
      builds += 1
      return reportFixtureBuild()
    },
    now: () => 1794000000000,
  })
  const head = fakeResponse()
  await handler({ method: 'HEAD', url: `${ROUTE}?days=30` }, head)
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)
  assert.match(head.headers['content-type'], /application\/json/)
  assert.equal(builds, 1, 'HEAD still builds/reads the index')

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = fakeResponse()
    await handler({ method, url: ROUTE }, response)
    assert.equal(response.status, 405, `${method} should be 405`)
    assert.equal(response.headers.allow, 'GET, HEAD')
    assert.equal(response.body, undefined)
  }
  assert.equal(builds, 1, 'rejected methods never build the index')
})

await testAsync('the handler answers 500 JSON on build failure and never throws', async () => {
  const handler = createReportHandler({
    loadIndex: async () => {
      throw new Error('disk exploded')
    },
    now: () => 1,
  })
  const response = fakeResponse()
  await assert.doesNotReject(() => handler({ method: 'GET', url: ROUTE }, response))
  assert.equal(response.status, 500)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'disk exploded' })

  const brokenBuild = createReportHandler({ loadIndex: async () => null })
  const broken = fakeResponse()
  await brokenBuild({ method: 'GET', url: ROUTE }, broken)
  assert.equal(broken.status, 500)
  assert.match(JSON.parse(broken.body).error, /no index/)
})

await testAsync('days query normalization and malformed URLs fall back to 30 without throwing', async () => {
  const handler = createReportHandler({ loadIndex: async () => reportFixtureBuild(), now: () => 1794000000000 })
  const cases = [
    [`${ROUTE}?days=90`, 90],
    [`${ROUTE}?days=7`, 7],
    [`${ROUTE}?days=45`, 30],
    [`${ROUTE}?days=abc`, 30],
    [`${ROUTE}`, 30],
    ['http://[invalid', 30],
    [undefined, 30],
  ]
  for (const [url, expected] of cases) {
    const response = fakeResponse()
    await handler({ method: 'GET', url }, response)
    assert.equal(response.status, 200, `url ${String(url)}`)
    assert.equal(JSON.parse(response.body).days, expected, `url ${String(url)}`)
  }
  // A missing response object must not throw either.
  await assert.doesNotReject(() => handler({ method: 'GET', url: ROUTE }, undefined))
})

await testAsync('concurrent requests share one in-flight build through the loader', async () => {
  let builds = 0
  let release = null
  const loader = createIndexLoader({
    buildIndex: () => {
      builds += 1
      return new Promise((resolve) => {
        release = () => resolve(reportFixtureBuild())
      })
    },
  })
  const handler = createReportHandler({ loadIndex: loader, now: () => 1794000000000 })
  const first = fakeResponse()
  const second = fakeResponse()
  const a = handler({ method: 'GET', url: ROUTE }, first)
  const b = handler({ method: 'GET', url: ROUTE }, second)
  await flush()
  assert.equal(builds, 1, 'two concurrent requests must join one build')
  release()
  await Promise.all([a, b])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  // Once the build settles, the next request starts a fresh one.
  const third = fakeResponse()
  const c = handler({ method: 'GET', url: ROUTE }, third)
  await flush()
  assert.equal(builds, 2)
  release()
  await c
})

// ===================================================================== apply()
await testAsync('apply() registers the exact report route inside one owned effect', async () => {
  await withFakeTimers(async ({ timers }) => {
    const ctx = fakeContext()
    assert.doesNotThrow(() => apply(ctx))
    assert.deepEqual(ctx.__injections, [['webServer']])
    assert.equal(ctx.__registrations.length, 1)
    const definition = ctx.__registrations[0]
    assert.equal(definition.kind, 'exact')
    assert.equal(definition.path, ROUTE)
    assert.equal(typeof definition.handler, 'function')
    const routeEffect = effectByLabel(ctx, 'usage-stats: report route')
    assert.ok(routeEffect, 'the route is owned by an effect with a label')
    assert.equal(typeof routeEffect.dispose, 'function')
    assert.equal(ctx.__warnings.length, 0)

    const warmup = effectByLabel(ctx, 'usage-stats: index warmup')
    assert.ok(warmup, 'warm-up is owned by an effect with a label')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, WARMUP_DELAY_MS)
    assert.equal(timers[0].cleared, false)

    routeEffect.dispose()
    assert.equal(definition.disposed, true, 'disposing the route effect disposes the registration')
    warmup.dispose()
    assert.equal(timers[0].cleared, true, 'disposing the warm-up effect clears the timer')
  })
})

await testAsync('apply() warm-up runs the shared loader off the activation path', async () => {
  await withFakeTimers(async ({ timers }) => {
    let calls = 0
    let builds = 0
    const loader = createIndexLoader({
      buildIndex: async () => {
        builds += 1
        return reportFixtureBuild()
      },
    })
    const countingLoader = () => {
      calls += 1
      return loader()
    }
    const ctx = fakeContext()
    apply(ctx, { loadIndex: countingLoader })
    const warmup = effectByLabel(ctx, 'usage-stats: index warmup')
    await timers[0].callback()
    await flush()
    assert.equal(calls, 1, 'the warm-up timer invokes the shared loader once')
    assert.equal(builds, 1)
    warmup.dispose()
  })
})

await testAsync('apply() survives a missing webServer service (route not registered, no throw)', async () => {
  await withFakeTimers(async ({ timers }) => {
    const ctx = fakeContext({ webServer: false })
    assert.doesNotThrow(() => apply(ctx))
    assert.equal(ctx.__registrations.length, 0)
    assert.equal(ctx.__warnings.length, 0, 'a missing optional service is not an error')
    assert.ok(effectByLabel(ctx, 'usage-stats: index warmup'))
    effectByLabel(ctx, 'usage-stats: index warmup').dispose()
    assert.equal(timers[0].cleared, true)
  })
})

await testAsync('apply() only warns when the route registration throws or there is no inject service', async () => {
  await withFakeTimers(async () => {
    const throwing = fakeContext({ throwOnRegister: new Error('route already taken') })
    assert.doesNotThrow(() => apply(throwing))
    assert.equal(throwing.__warnings.length, 1)
    assert.match(throwing.__warnings[0], /report route registration failed: route already taken/)
    const routeEffect = effectByLabel(throwing, 'usage-stats: report route')
    assert.equal(typeof routeEffect.dispose, 'function')
    assert.doesNotThrow(() => routeEffect.dispose())
    effectByLabel(throwing, 'usage-stats: index warmup').dispose()

    const noInject = fakeContext()
    delete noInject.inject
    assert.doesNotThrow(() => apply(noInject))
    assert.equal(noInject.__warnings.length, 1)
    assert.match(noInject.__warnings[0], /no inject service/)
    effectByLabel(noInject, 'usage-stats: index warmup').dispose()
  })
})

await testAsync('apply() survives contexts without effect/register services', async () => {
  await withFakeTimers(async ({ timers }) => {
    const noEffect = fakeContext()
    delete noEffect.effect
    assert.doesNotThrow(() => apply(noEffect))
    assert.equal(noEffect.__warnings.length, 1)
    assert.match(noEffect.__warnings[0], /lacks effect/)
    assert.equal(timers.length, 1, 'warm-up still schedules without an effect service')
    assert.doesNotThrow(() => timers[0].callback())

    const noWebServer = fakeContext()
    delete noWebServer.webServer
    assert.doesNotThrow(() => apply(noWebServer))
    assert.equal(noWebServer.__registrations.length, 0)
    assert.match(noWebServer.__warnings[0], /webServer service unavailable/)
    effectByLabel(noWebServer, 'usage-stats: index warmup').dispose()
  })
})

await testAsync('warmIndex only warns (never throws) when the index build fails', async () => {
  const ctx = fakeContext()
  const value = await warmIndex(ctx, {
    buildIndex: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(value, null)
  assert.equal(ctx.__warnings.length, 1)
  assert.match(ctx.__warnings[0], /index prewarm failed: boom/)

  const okCtx = fakeContext()
  const index = await warmIndex(okCtx, { loadIndex: async () => ({ index: emptyIndex(480, 1) }) })
  assert.deepEqual(index, emptyIndex(480, 1))
  assert.equal(okCtx.__warnings.length, 0)
})

await testAsync('apply() integration: the registered handler serves a real temp-home index', async () => {
  const home = await makeTempHome()
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    await writeSessionLog(home, 'session-route', logText('session-route', { input: 8, output: 2, cacheRead: 80, time: Date.now() }))
    await withFakeTimers(async () => {
      const ctx = fakeContext()
      apply(ctx)
      const handler = ctx.__registrations[0].handler
      const response = fakeResponse()
      await handler({ method: 'GET', url: `${ROUTE}?days=7` }, response)
      assert.equal(response.status, 200)
      const report = JSON.parse(response.body)
      assert.equal(report.ok, true)
      assert.equal(report.index.files, 1)
      assert.equal(report.index.sessions, 1)
      assert.equal(report.totals.input, 8)
      assert.equal(report.totals.output, 2)
      assert.equal(report.totals.cacheRead, 80)
      assert.equal(report.categories.chat.input, 8, 'a session without code/team tools is a chat session')
      assert.equal(report.daily.length, 7)
      assert.equal(existsSync(path.join(home, CACHE_RELATIVE_PATH)), true, 'the route populated the temp cache')
      effectByLabel(ctx, 'usage-stats: index warmup').dispose()
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

// ================================================================= real data
async function copySmallestRealLogs(realLogs, destination, count) {
  const sized = []
  for (const log of realLogs) {
    try {
      const info = await stat(log.file)
      sized.push({ ...log, size: info.size })
    } catch {
      /* ignore unreadable */
    }
  }
  sized.sort((left, right) => left.size - right.size)
  const chosen = sized.slice(0, count)
  for (const log of chosen) {
    const target = path.join(destination, 'sessions', 'copied', log.id)
    await mkdir(target, { recursive: true })
    await copyFile(log.file, path.join(target, 'session.v4.jsonl.zstd'))
  }
  return chosen
}

const REAL_HOME = path.join(os.homedir(), '.dsh')
const REAL_SESSIONS = path.join(REAL_HOME, 'sessions')
const REAL_PROJCACHE = path.join(REAL_HOME, 'storages', 'session_projcache', 'sessions')
const REAL_DATA = existsSync(REAL_SESSIONS) && existsSync(REAL_PROJCACHE)

const reportSample = { chat: null, cowork: null, code: null, totals: null }
let realFirstMs = null
let realSecondMs = null

await testAsync('real data: incremental reuse on copied real logs is exact and does not rewrite the cache', async () => {
  if (!REAL_DATA) {
    console.log('   SKIP real-log incremental check: no ~/.dsh data')
    return
  }
  const realLogs = await discoverLogs(REAL_SESSIONS)
  assert.ok(realLogs.length > 20, `expected real session logs, found ${realLogs.length}`)
  const home = await makeTempHome()
  try {
    const copied = await copySmallestRealLogs(realLogs, home, 20)
    const cacheFile = path.join(home, CACHE_RELATIVE_PATH)
    const first = await buildIndex({ dshHome: home, cacheFile })
    assert.equal(first.stats.files, copied.length)
    assert.equal(first.stats.scanned, copied.length)
    assert.equal(first.wroteCache, true)
    const second = await buildIndex({ dshHome: home, cacheFile })
    assert.equal(second.stats.files, copied.length)
    assert.equal(second.stats.reused, copied.length)
    assert.equal(second.stats.scanned, 0)
    assert.equal(second.stats.skipped, 0)
    assert.equal(second.wroteCache, false, 'a no-change build must not rewrite the cache')
    assert.ok(second.buildMs < 200, `incremental build should be < 200 ms, was ${second.buildMs} ms`)
    console.log(`   [real-copy] ${copied.length} logs: first ${first.buildMs} ms, second ${second.buildMs} ms (reused ${second.stats.reused})`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await testAsync('real data: full scan timing and projcache tokenUsage parity (hard acceptance)', async () => {
  if (!REAL_DATA) {
    console.log('   SKIP real-data parity: ~/.dsh/storages/session_projcache not found')
    return
  }
  const temp = await makeTempHome()
  try {
    const cacheFile = path.join(temp, CACHE_RELATIVE_PATH)
    const startedFirst = performance.now()
    const first = await buildIndex({ dshHome: REAL_HOME, cacheFile })
    realFirstMs = Math.round(performance.now() - startedFirst)
    const startedSecond = performance.now()
    const second = await buildIndex({ dshHome: REAL_HOME, cacheFile })
    realSecondMs = Math.round(performance.now() - startedSecond)
    assert.ok(first.stats.files > 0, 'expected real session logs')
    assert.equal(first.stats.scanned + first.stats.skipped, first.stats.files)
    assert.equal(second.stats.reused + second.stats.scanned + second.stats.skipped, second.stats.files)
    if (second.stats.scanned === 0) {
      assert.ok(realSecondMs < 200, `incremental scan of real logs should be < 200 ms, was ${realSecondMs} ms`)
      assert.equal(second.wroteCache, false)
    } else {
      console.log(`   [real] ${second.stats.scanned} log(s) changed between builds (live session), reuse check relaxed`)
    }
    console.log(`   [real] ${first.stats.files} files / ${first.stats.sessions} sessions: first ${realFirstMs} ms, second ${realSecondMs} ms, reused ${second.stats.reused}, skipped ${second.stats.skipped}`)

    // Report sample numbers (SPEC §4.3) for the lead's acceptance report.
    const report = aggregateReport(second.index, { days: 30, now: Date.now(), stats: second.stats, buildMs: second.buildMs })
    for (const category of CATEGORIES) {
      reportSample[category] = {
        input: report.categories[category].input,
        output: report.categories[category].output,
        cacheRead: report.categories[category].cacheRead,
        inputPlusOutput: report.categories[category].input + report.categories[category].output,
        webSearches: report.categories[category].webSearches,
        sessions: report.categories[category].sessions,
      }
    }
    reportSample.totals = report.totals
    assert.equal(report.totals.input, report.categories.chat.input + report.categories.cowork.input + report.categories.code.input)
    assert.equal(report.daily.length, 30)
    assert.equal(report.models.length > 0, true)

    // Per-session parity against the shipped tokenUsage projection cache.
    const projectionFiles = await readdir(REAL_PROJCACHE)
    const byUuid = new Map(Object.entries(second.index.sessions).map(([id, entry]) => [id.replace(/^session-/, ''), entry]))
    const quietBefore = Date.now() - 120000
    const candidates = []
    for (const fileName of projectionFiles) {
      if (!fileName.endsWith('.json')) continue
      const uuid = fileName.slice(0, -'.json'.length).replace(/^session-/, '')
      const entry = byUuid.get(uuid)
      if (!entry) continue
      if (entry.mtimeMs > quietBefore) continue // session may still be appended to / projection checkpoint stale
      candidates.push({ uuid, fileName, entry })
    }
    candidates.sort((left, right) => left.entry.mtimeMs - right.entry.mtimeMs)
    const sample = candidates.slice(0, 20)
    if (sample.length === 0) {
      console.log('   SKIP projcache parity: no quiet real sessions found')
      return
    }
    let matched = 0
    for (const { uuid, fileName, entry } of sample) {
      const projection = JSON.parse(await readFile(path.join(REAL_PROJCACHE, fileName), 'utf8'))
      const expected = projection?.record?.rows?.tokenUsage?.val?.totals
      if (!expected) continue
      // 1) totals folded by buildIndex.
      const fromIndex = totalsOfDays(entry.days)
      assert.deepEqual(fromIndex, {
        input: expected.uncachedInputTokens,
        output: expected.outputTokens,
        cacheRead: expected.cacheReadTokens,
        cacheWrite: expected.cacheWriteTokens,
      }, `index totals differ from projcache for ${uuid}`)
      // 2) the fold itself, re-run directly on the log file.
      const raw = await readFile(entry.file)
      const tz = second.index.tzOffsetMinutes
      const folded = entry.file.endsWith('.jsonl')
        ? foldSessionText(raw.toString('utf8'), { tzOffsetMinutes: tz })
        : foldSessionBuffer(raw, { tzOffsetMinutes: tz })
      assert.deepEqual(totalsOfDays(folded.days), fromIndex, `foldSessionBuffer totals differ for ${uuid}`)
      matched += 1
    }
    assert.ok(matched >= Math.min(20, sample.length), `checked only ${matched} sessions`)
    console.log(`   [parity] projcache tokenUsage: ${matched}/${sample.length} sessions match exactly (4 fields each)`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('real data: 30-day report sample was captured for the acceptance report', () => {
  if (!REAL_DATA || reportSample.totals === null) {
    console.log('   SKIP report sample: real data unavailable')
    return
  }
  for (const category of CATEGORIES) {
    assert.ok(reportSample[category].inputPlusOutput >= 0)
    process.stdout.write(`   [report] ${category}: input ${reportSample[category].input}, output ${reportSample[category].output}, ` +
      `io ${reportSample[category].inputPlusOutput}, cacheRead ${reportSample[category].cacheRead}, ` +
      `web ${reportSample[category].webSearches}, sessions ${reportSample[category].sessions}\n`)
  }
  process.stdout.write(`   [report] totals: ${JSON.stringify(reportSample.totals)}\n`)
  process.stdout.write(`   [report] real first scan ${realFirstMs} ms, incremental ${realSecondMs} ms\n`)
})

// ===================================================================== summary
await flush()
if (failures.length > 0) {
  console.log(`\n${passed} tests passed, ${failures.length} FAILED`)
  for (const failure of failures) console.log(' -', failure.name)
  process.exitCode = 1
} else {
  console.log(`\n${passed} host tests passed`)
}