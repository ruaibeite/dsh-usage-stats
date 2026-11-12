/**
 * @ruaibeite/dsh-usage-stats — host half.
 *
 * Folds the device's local session logs into a token-usage index and serves one
 * read-only route, `GET /dsh-usage-stats/report?days=7|30|90`, which the browser
 * half renders on the settings "Usage" page.
 *
 * Everything is derived, never authoritative: this module only READS
 * `$DSH_HOME/sessions/**\/session.v4.jsonl.zstd` (and uncompressed
 * `session.v4.jsonl`), folds the usage samples into a JSON index cached at
 * `$DSH_HOME/cache/usage-stats/index.json`, and aggregates that cache for the
 * requested day range. It writes no session, calls no model, sends no network
 * request, and imports nothing outside `node:` builtins — the profile's
 * `node_modules` does not carry `@deepseek-ai/*` for plugins.
 *
 * Accounting parity: the fold reproduces the shipped `tokenUsage` unit's
 * replacement semantics (one sample per `turn`/`step`, retried attempts clear
 * the replacement slot), so the totals per session match the DSH projection
 * cache `$DSH_HOME/storages/session_projcache` exactly. That parity is the hard
 * acceptance criterion for this plugin.
 *
 * The route handler must never throw into the web server: every failure is a
 * 500 JSON body. Index building runs lazily on the first request and again on a
 * 4 s activation warm-up timer, both off the activation path.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Route served to the browser half. */
export const ROUTE = '/dsh-usage-stats/report'

/** Index cache schema version. */
export const INDEX_VERSION = 1

/** Day ranges the report route accepts; anything else falls back to {@link DEFAULT_RANGE_DAYS}. */
export const RANGES = [7, 30, 90]

/** Default report range in days. */
export const DEFAULT_RANGE_DAYS = 30

/** Session categories, in display order. */
export const CATEGORIES = ['chat', 'cowork', 'code']

/** Delay before the background index warm-up fires after activation. */
export const WARMUP_DELAY_MS = 4000

/** Cache path relative to `$DSH_HOME`. */
export const CACHE_RELATIVE_PATH = path.join('cache', 'usage-stats', 'index.json')

/** Session roots relative to `$DSH_HOME`. */
export const SESSIONS_RELATIVE_PATH = 'sessions'

/** Compressed log name, then the uncompressed fallback the JSONL backend also writes. */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/** `session-<uuid>` directory basenames are the index keys. */
const SESSION_DIR_PATTERN = /^session-[0-9a-f][0-9a-f-]*$/i

/** `YYYY-MM-DD` local bucket names. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** One local day in milliseconds (fixed-offset arithmetic, see {@link dayOfTime}). */
const DAY_MS = 86400000

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Finite number or 0. */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Finite, non-negative integer (stored counters; negatives are corruption). */
const toNonNegativeInt = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value > 0 ? Math.floor(value) : 0
}

/**
 * Finite, non-negative number, fractional part preserved.
 *
 * `stat().mtimeMs` is a float on macOS; truncating it here would make the
 * cached `mtimeMs` permanently differ from the fresh stat and silently disable
 * the whole incremental-reuse path. Only `size` is an integer.
 */
const toNonNegativeNumber = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value > 0 ? value : 0
}

/** Short human message for a thrown value. */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** A zeroed four-bucket usage counter. */
function emptyUsageBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** A zeroed category counter (usage plus the report-only fields). */
function emptyCategoryBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, sessions: 0 }
}

/** Add a `{input,output,cacheRead,cacheWrite}` bucket into another one. */
function addUsageBucket(target, bucket) {
  target.input += num(bucket.input)
  target.output += num(bucket.output)
  target.cacheRead += num(bucket.cacheRead)
  target.cacheWrite += num(bucket.cacheWrite)
}

/**
 * Resolve `$DSH_HOME` (`process.env.DSH_HOME`, else `~/.dsh`).
 *
 * Read lazily at request/warm-up time, never at module load, so tests can point
 * the plugin at a temporary home by setting the environment variable.
 *
 * @param env - environment bag, defaults to `process.env`.
 * @param home - home directory, defaults to `os.homedir()`.
 * @returns absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const explicit = env !== null && env !== undefined ? env.DSH_HOME : undefined
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  return path.join(home, '.dsh')
}

/** Current host UTC offset in minutes east of UTC (`-Date#getTimezoneOffset`). */
export function currentTzOffsetMinutes() {
  return -new Date().getTimezoneOffset()
}

/**
 * Local calendar day (`YYYY-MM-DD`) of an epoch-ms timestamp.
 *
 * The offset is applied as a fixed shift and read back with UTC getters, which
 * is the same wall-clock day as `new Date(time).getFullYear()/getMonth()/…
 * for the current offset — but it is deterministic and testable without
 * mutating `TZ`. The index cache records this offset and is rebuilt whenever it
 * changes, so a fixed-offset interpretation is also exactly the SPEC contract.
 *
 * @param time - epoch milliseconds.
 * @param tzOffsetMinutes - offset east of UTC; defaults to the host offset.
 * @returns `YYYY-MM-DD`, or `null` when `time` is not finite.
 */
export function dayOfTime(time, tzOffsetMinutes = currentTzOffsetMinutes()) {
  const timestamp = typeof time === 'number' && Number.isFinite(time) ? time : null
  if (timestamp === null) return null
  const shifted = timestamp + num(tzOffsetMinutes) * 60000
  return new Date(shifted).toISOString().slice(0, 10)
}

/** Normalize a `days` query value to one of {@link RANGES}, else the default. */
export function normalizeDays(value) {
  const candidate = typeof value === 'number' ? value : Number.parseInt(String(value === null || value === undefined ? '' : value), 10)
  return RANGES.includes(candidate) ? candidate : DEFAULT_RANGE_DAYS
}

/**
 * Inclusive calendar-day range ending at `now`'s local day.
 *
 * @param days - already-normalized range length.
 * @param now - epoch ms of "today".
 * @param tzOffsetMinutes - host offset east of UTC.
 * @returns `{ from, to, list }` where `list` is ascending `YYYY-MM-DD`.
 */
export function rangeDays(days, now = Date.now(), tzOffsetMinutes = currentTzOffsetMinutes()) {
  const length = normalizeDays(days)
  const timestamp = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const shifted = new Date(timestamp + num(tzOffsetMinutes) * 60000)
  const todayUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  const startUtc = todayUtc - (length - 1) * DAY_MS
  const list = []
  for (let index = 0; index < length; index += 1) {
    list.push(new Date(startUtc + index * DAY_MS).toISOString().slice(0, 10))
  }
  return { from: list[0], to: list[list.length - 1], list }
}

// ---------------------------------------------------------------------------
// Zstandard multi-frame decoding
// ---------------------------------------------------------------------------

/** Zstandard frame magic, little endian (`0xFD2FB528`). */
export const ZSTD_MAGIC = 4247762216

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Copied from `@deepseek-ai/dsh-session-persistence-jsonl` (MIT), module
 * `lib/types/zstd.js`, because Node's `zlib.zstdDecompressSync` decodes only
 * the FIRST frame while the JSONL backend appends each flush batch as an
 * independent frame to one container file. Invalid complete structure throws
 * (callers treat the file as `skipped`); EOF inside the final frame returns its
 * `tornStart` so the caller can drop the torn tail, exactly like the shipped
 * reader does.
 *
 * @param buffer - complete file bytes.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('usage-stats: scanZstdFrames expects a Buffer')
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decompress every complete frame and join the plaintext.
 *
 * Used by tests and by callers that need the whole decoded log; the hot fold
 * path decodes frame by frame instead so a 40 MB session never sits in memory
 * as one string.
 *
 * @param buffer - complete `.jsonl.zstd` bytes.
 * @returns concatenated UTF-8 JSONL text.
 */
export function decodeZstdFrames(buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = new Array(frames.length)
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    parts[index] = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
  }
  return Buffer.concat(parts).toString('utf8')
}

// ---------------------------------------------------------------------------
// Event folding
// ---------------------------------------------------------------------------

/**
 * Event header. SPEC final form; `time` is optional because old/live logs may
 * omit it (the fold then carries the previous event's timestamp forward).
 */
const RE_HEAD = /^\{"type":"([^"]+)"(?:,"seq":(\d+))?(?:,"time":(\d+))?(?:,|$)/

/** One flat usage object per match; usage objects never nest. */
const RE_USAGE = /"usage":(\{[^{}]*\})/g

/** `turn`/`step` live in `data` before big message content; a prefix scan is enough. */
const RE_TURN_STEP = /"turn":(\d+),"step":(\d+)/

/** Assistant message model route. */
const RE_SOURCE = /"source":\{"kind":"model","provider":"([^"]+)","model":"([^"]+)"/

/** Last request route (`request/context` / `request/header`). */
const RE_ROUTE = /"provider":"([^"]+)","model":"([^"]+)"/

/** First tool name on a `tool/call` line. */
const RE_TOOL_NAME = /"name":"([^"]+)"/

/** Session header fields. */
const RE_CREATED_AT = /"createdAt":(\d+)/
const RE_CWD = /"cwd":"((?:[^"\\]|\\.)*)"/

/** Tools that make a session "code" (code execution / filesystem mutation). */
export const CODE_TOOL_PATTERN = /^(bash|pwsh|run_code|terminal|shell|exec|write|edit|apply_patch|str_replace|fs_write|fs_edit|notebook|jobs|job_|workflow|ralph|plugin_manager|worktree)/

/** Tools that make a session "cowork" (Agent Teams). */
export const TEAM_TOOL_PATTERN = /^(spawn_teammate|send_message|team_task_|list_agents|wait_agent|interrupt_agent)/

/** Tools counted as web searches and attributed to the most recent model. */
export const WEB_TOOL_PATTERN = /^(web_search|web_fetch|websearch|webfetch)/

/**
 * Scenario category of a session from its tool names. Cowork wins over code:
 * an Agent Teams session that also runs code is still a Cowork session.
 *
 * @param toolNames - one tool name or any iterable of names.
 * @returns `cowork`, `code` or `chat`.
 */
export function categoryOfTools(toolNames) {
  let hasCode = false
  let hasTeam = false
  const consume = (name) => {
    if (typeof name !== 'string' || name === '') return
    if (!hasTeam && TEAM_TOOL_PATTERN.test(name)) hasTeam = true
    if (!hasCode && CODE_TOOL_PATTERN.test(name)) hasCode = true
  }
  if (typeof toolNames === 'string') consume(toolNames)
  else if (toolNames !== null && toolNames !== undefined && typeof toolNames[Symbol.iterator] === 'function') {
    for (const name of toolNames) consume(name)
  }
  return hasTeam ? 'cowork' : hasCode ? 'code' : 'chat'
}

/** Copy a usage object's four buckets; `null` when it is not a usable sample. */
function bucketOfUsage(usage) {
  if (!isObject(usage)) return null
  if (typeof usage.inputTokens !== 'number' || !Number.isFinite(usage.inputTokens)) return null
  if (typeof usage.outputTokens !== 'number' || !Number.isFinite(usage.outputTokens)) return null
  return {
    input: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
  }
}

/** First valid `"usage":{…}` object on a line, or `null`. */
function firstUsage(line) {
  RE_USAGE.lastIndex = 0
  for (const match of line.matchAll(RE_USAGE)) {
    const bucket = parseUsageText(match[1])
    if (bucket !== null) return bucket
  }
  return null
}

/** Last valid `"usage":{…}` object on a line (stream chunks), or `null`. */
function lastUsage(line) {
  RE_USAGE.lastIndex = 0
  let result = null
  for (const match of line.matchAll(RE_USAGE)) {
    const bucket = parseUsageText(match[1])
    if (bucket !== null) result = bucket
  }
  return result
}

/** Parse one flat usage object body; `null` unless input/output are finite numbers. */
function parseUsageText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return bucketOfUsage(parsed)
}

/** Decode a JSON string body captured by a regex (e.g. `cwd`). */
function decodeJsonString(body) {
  try {
    return JSON.parse(`"${body}"`)
  } catch {
    return null
  }
}

/** Fresh per-session fold state. */
function createSessionFold(options = {}) {
  return {
    tzOffsetMinutes: Number.isInteger(options.tzOffsetMinutes) ? options.tzOffsetMinutes : currentTzOffsetMinutes(),
    headerSeen: false,
    createdAt: 0,
    cwd: null,
    lastTime: 0,
    records: [],
    last: null,
    route: null,
    lastModel: null,
    hasCode: false,
    hasTeam: false,
  }
}

/** Add (or replace) one usage sample, mirroring the shipped `tokenUsage` unit. */
function addUsageSample(state, time, source, bucket, turnStep) {
  state.lastModel = source
  const turn = turnStep === null ? -1 : Number.parseInt(turnStep[1], 10)
  const step = turnStep === null ? -1 : Number.parseInt(turnStep[2], 10)
  const record = { kind: 'usage', time, provider: source.provider, model: source.model, bucket }
  const previous = state.last
  if (previous !== null && previous.turn === turn && previous.step === step) {
    // Retry of the same attempt: the later sample replaces the earlier one
    // instead of double-counting (exactly the `tokenUsage` replacement rule).
    state.records[previous.idx] = record
    return
  }
  state.records.push(record)
  state.last = { turn, step, idx: state.records.length - 1 }
}

/**
 * Unknown-model fallback.
 *
 * The shipped `tokenUsage` unit counts every usage sample no matter whether the
 * model route was recorded; old or non-standard logs can therefore carry usage
 * without `message.source` and without a preceding `request/*` route. Dropping
 * those samples would silently break the accounting-parity acceptance
 * criterion, so they count under an explicit `unknown` model instead (the page
 * renders it as an unknown model).
 */
const UNKNOWN_MODEL = Object.freeze({ provider: '', model: 'unknown' })

/** Fold one `assistant/message` line. */
function foldAssistantMessage(state, line, time) {
  // The shipped unit prefers the message's own `data.usage` and falls back to
  // the last streamed usage chunk when the message carries none, so a settlement
  // without the compact usage object still counts.
  let bucket = firstUsage(line)
  if (bucket === null) bucket = lastUsage(line)
  if (bucket === null) return
  let source = null
  const match = RE_SOURCE.exec(line)
  if (match !== null) source = { provider: match[1], model: match[2] }
  if (source === null) source = state.route
  if (source === null) source = UNKNOWN_MODEL
  addUsageSample(state, time, source, bucket, RE_TURN_STEP.exec(line.slice(0, 300)))
}

/** Fold one `assistant/attempt` line (stream usage chunks; model from the last request route). */
function foldAssistantAttempt(state, line, time) {
  const bucket = lastUsage(line)
  if (bucket === null) return
  const source = state.route === null ? UNKNOWN_MODEL : state.route
  addUsageSample(state, time, source, bucket, RE_TURN_STEP.exec(line.slice(0, 300)))
}

/** Fold one `tool/call` line: classification flags plus web-search attribution. */
function foldToolCall(state, line, time) {
  const match = RE_TOOL_NAME.exec(line)
  if (match === null) return
  const name = match[1]
  if (TEAM_TOOL_PATTERN.test(name)) state.hasTeam = true
  if (CODE_TOOL_PATTERN.test(name)) state.hasCode = true
  if (!WEB_TOOL_PATTERN.test(name)) return
  // Web searches are counted per day and attributed to the model that most
  // recently produced an assistant message; sessions without one get `unknown`.
  state.records.push({ kind: 'web', time, model: state.lastModel === null ? 'unknown' : state.lastModel.model })
}

/**
 * Fold one already-decoded JSONL line into the session state.
 *
 * Only line prefixes are inspected for irrelevant events; the heavy
 * `assistant/*` content is never `JSON.parse`d as a whole — usage is pulled out
 * with a flat-object regex and the model route with a dedicated regex, keeping
 * multi-megabyte lines cheap.
 *
 * @param state - internal fold state.
 * @param line - one JSONL line without its newline.
 */
export function foldLine(state, line) {
  if (typeof line !== 'string' || line === '') return
  if (!state.headerSeen) {
    // The first event of every log is the small `{"type":"session",…}` header.
    if (line.startsWith('{"type":"session"')) {
      state.headerSeen = true
      const created = RE_CREATED_AT.exec(line)
      if (created !== null) state.createdAt = Number.parseInt(created[1], 10) || 0
      const cwd = RE_CWD.exec(line)
      if (cwd !== null) state.cwd = decodeJsonString(cwd[1])
    }
  }
  const head = RE_HEAD.exec(line)
  if (head === null) return
  const type = head[1]
  const explicitTime = head[3] === undefined ? null : Number.parseInt(head[3], 10)
  const time = explicitTime === null ? state.lastTime || state.createdAt || 0 : explicitTime
  if (explicitTime !== null) state.lastTime = explicitTime
  switch (type) {
    case 'assistant/message':
      foldAssistantMessage(state, line, time)
      return
    case 'assistant/attempt':
      foldAssistantAttempt(state, line, time)
      return
    case 'llm/retry-started': {
      // SPEC: clear the replacement slot when this retry belongs to the last
      // sample's attempt, so the failed attempt's usage is kept and the retried
      // attempt accumulates. Without turn/step information, fall back to the
      // shipped unit's behaviour (clear while a route is known).
      if (state.last === null) return
      const turnStep = RE_TURN_STEP.exec(line.slice(0, 300))
      if (turnStep !== null) {
        if (state.last.turn === Number.parseInt(turnStep[1], 10) && state.last.step === Number.parseInt(turnStep[2], 10)) {
          state.last = null
        }
      } else if (state.route !== null) {
        state.last = null
      }
      return
    }
    case 'request/context':
    case 'request/header': {
      const match = RE_ROUTE.exec(line)
      if (match !== null) state.route = { provider: match[1], model: match[2] }
      return
    }
    case 'tool/call':
      foldToolCall(state, line, time)
      return
    default:
      return
  }
}

/**
 * Fold decoded JSONL lines into a session summary.
 *
 * @param lines - iterable of JSONL strings (newlines already split; either may
 *   still carry a trailing `\r`, which does not affect any prefix match).
 * @param options - `{ tzOffsetMinutes }` for local-day bucketing.
 * @returns `{ createdAt, cwd, category, models, providers, days, totals,
 *   webSearches, hasCode, hasTeam }`.
 */
export function foldLines(lines, options = {}) {
  const state = createSessionFold(options)
  for (const line of lines) {
    if (line === '') continue
    foldLine(state, line)
  }
  return finishSessionFold(state)
}

/** Fold a plaintext (uncompressed) JSONL session log. */
export function foldSessionText(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text === null || text === undefined ? '' : text)
  return foldLines(source.split('\n'), options)
}

/**
 * Fold one complete `.jsonl.zstd` file without materialising the whole decoded
 * log: frames are decompressed one at a time and only complete lines are
 * processed, with a byte carry across frame boundaries so a multi-byte UTF-8
 * character split between frames is decoded correctly.
 *
 * @param buffer - complete file bytes.
 * @param options - `{ tzOffsetMinutes }`.
 * @throws when the container is structurally corrupt (callers count a skip).
 */
export function foldSessionBuffer(buffer, options = {}) {
  const { frames } = scanZstdFrames(buffer)
  const state = createSessionFold(options)
  let carry = Buffer.alloc(0)
  for (const frame of frames) {
    const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    if (plain.length === 0 && carry.length === 0) continue
    const chunk = carry.length === 0 ? plain : Buffer.concat([carry, plain])
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(10, start)
      if (newline === -1) break
      foldLine(state, chunk.toString('utf8', start, newline))
      start = newline + 1
    }
    carry = start < chunk.length ? chunk.subarray(start) : Buffer.alloc(0)
  }
  if (carry.length > 0) foldLine(state, carry.toString('utf8'))
  return finishSessionFold(state)
}

/**
 * Turn the folded records into the cache-ready session summary.
 *
 * Records are accumulated in log order; the replacement rule above already
 * decided which samples survive, so this pass only buckets them by local day
 * and model.
 */
function finishSessionFold(state) {
  const days = new Map()
  const providers = new Map()
  const totals = emptyUsageBucket()
  let webSearches = 0
  const dayBucket = (day) => {
    const key = day === null ? '1970-01-01' : day
    let bucket = days.get(key)
    if (bucket === undefined) {
      bucket = { usage: {}, web: 0, webByModel: {} }
      days.set(key, bucket)
    }
    return bucket
  }
  for (const record of state.records) {
    if (record.kind === 'usage') {
      const day = dayOfTime(record.time, state.tzOffsetMinutes)
      const bucket = dayBucket(day)
      let values = bucket.usage[record.model]
      if (values === undefined) {
        values = [0, 0, 0, 0]
        bucket.usage[record.model] = values
      }
      values[0] += record.bucket.input
      values[1] += record.bucket.output
      values[2] += record.bucket.cacheRead
      values[3] += record.bucket.cacheWrite
      addUsageBucket(totals, record.bucket)
      let providerSet = providers.get(record.model)
      if (providerSet === undefined) {
        providerSet = new Set()
        providers.set(record.model, providerSet)
      }
      // The unknown-model fallback carries no provider; never leak `''` into
      // the report's provider lists.
      if (record.provider !== '') providerSet.add(record.provider)
      continue
    }
    const bucket = dayBucket(dayOfTime(record.time, state.tzOffsetMinutes))
    bucket.web += 1
    bucket.webByModel[record.model] = (bucket.webByModel[record.model] || 0) + 1
    webSearches += 1
  }
  const daysObject = {}
  for (const day of [...days.keys()].sort()) daysObject[day] = days.get(day)
  const providerObject = {}
  for (const model of [...providers.keys()].sort()) providerObject[model] = [...providers.get(model)].sort()
  return {
    createdAt: state.createdAt,
    cwd: state.cwd,
    category: state.hasTeam ? 'cowork' : state.hasCode ? 'code' : 'chat',
    models: Object.keys(providerObject),
    providers: providerObject,
    days: daysObject,
    totals,
    webSearches,
    hasCode: state.hasCode,
    hasTeam: state.hasTeam,
  }
}

// ---------------------------------------------------------------------------
// Index cache
// ---------------------------------------------------------------------------

/**
 * A fresh, empty v1 index.
 *
 * @param tzOffsetMinutes - host offset east of UTC.
 * @param createdAt - index creation timestamp.
 */
export function emptyIndex(tzOffsetMinutes = currentTzOffsetMinutes(), createdAt = Date.now()) {
  return {
    version: INDEX_VERSION,
    tzOffsetMinutes: Number.isInteger(tzOffsetMinutes) ? tzOffsetMinutes : currentTzOffsetMinutes(),
    createdAt: toNonNegativeInt(createdAt),
    sessions: {},
  }
}

/** Sanitize one cached session entry; `null` forces a rescan. */
function parseSessionEntry(value) {
  if (!isObject(value)) return null
  if (typeof value.file !== 'string' || value.file === '') return null
  if (!CATEGORIES.includes(value.category)) return null
  const models = []
  if (Array.isArray(value.models)) {
    for (const model of value.models) {
      if (typeof model === 'string' && model !== '' && !models.includes(model)) models.push(model)
    }
  }
  const providers = {}
  if (isObject(value.providers)) {
    for (const [model, list] of Object.entries(value.providers)) {
      if (typeof model !== 'string' || model === '' || !Array.isArray(list)) continue
      const cleaned = []
      for (const provider of list) {
        if (typeof provider === 'string' && provider !== '' && !cleaned.includes(provider)) cleaned.push(provider)
      }
      providers[model] = cleaned.sort()
    }
  }
  const days = {}
  if (isObject(value.days)) {
    for (const [day, raw] of Object.entries(value.days)) {
      if (!DAY_PATTERN.test(day) || !isObject(raw)) continue
      const usage = {}
      if (isObject(raw.usage)) {
        for (const [model, values] of Object.entries(raw.usage)) {
          if (typeof model !== 'string' || model === '' || !Array.isArray(values) || values.length < 4) continue
          usage[model] = [
            toNonNegativeInt(values[0]),
            toNonNegativeInt(values[1]),
            toNonNegativeInt(values[2]),
            toNonNegativeInt(values[3]),
          ]
        }
      }
      const webByModel = {}
      if (isObject(raw.webByModel)) {
        for (const [model, count] of Object.entries(raw.webByModel)) {
          if (typeof model !== 'string' || model === '') continue
          const tokens = toNonNegativeInt(count)
          if (tokens > 0) webByModel[model] = tokens
        }
      }
      days[day] = { usage, web: toNonNegativeInt(raw.web), webByModel }
    }
  }
  return {
    file: value.file,
    size: toNonNegativeInt(value.size),
    mtimeMs: toNonNegativeNumber(value.mtimeMs),
    createdAt: toNonNegativeInt(value.createdAt),
    cwd: typeof value.cwd === 'string' ? value.cwd : null,
    category: value.category,
    models,
    providers,
    days,
  }
}

/**
 * Validate a stored index.
 *
 * @param value - parsed JSON value.
 * @param expectedTzOffsetMinutes - when an integer, an index recorded under a
 *   different offset is rejected so the whole index is rebuilt (SPEC §4.1).
 * @returns a sanitized index, or `null` when it must be treated as absent.
 */
export function parseIndex(value, expectedTzOffsetMinutes) {
  if (!isObject(value)) return null
  if (value.version !== INDEX_VERSION) return null
  if (!Number.isInteger(value.tzOffsetMinutes)) return null
  if (Number.isInteger(expectedTzOffsetMinutes) && value.tzOffsetMinutes !== expectedTzOffsetMinutes) return null
  const sessions = {}
  if (isObject(value.sessions)) {
    for (const [id, raw] of Object.entries(value.sessions)) {
      if (typeof id !== 'string' || id === '') continue
      const entry = parseSessionEntry(raw)
      if (entry !== null) sessions[id] = entry
    }
  }
  return {
    version: INDEX_VERSION,
    tzOffsetMinutes: value.tzOffsetMinutes,
    createdAt: toNonNegativeInt(value.createdAt),
    sessions,
  }
}

/** Read the JSON index file; any failure means "no usable cache". */
async function readIndexText(cacheFile, readFileFn) {
  try {
    return await readFileFn(cacheFile, 'utf8')
  } catch {
    return null
  }
}

/** Atomically replace the index file: unique temp file, then `rename`. */
async function writeIndexFile(cacheFile, index, deps) {
  const directory = path.dirname(cacheFile)
  await deps.mkdir(directory, { recursive: true })
  const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  const body = `${JSON.stringify(index)}\n`
  await deps.writeFile(temporary, body)
  try {
    await deps.rename(temporary, cacheFile)
  } catch (error) {
    try {
      await deps.rm(temporary, { force: true })
    } catch {
      /* best-effort cleanup only */
    }
    throw error
  }
}

/**
 * Discover session logs under `$DSH_HOME/sessions`, recursively.
 *
 * Both the compressed and the plaintext JSONL names are recognized. If a
 * session directory holds both (format migration in progress), the compressed
 * file wins so the same session is never folded twice. Unreadable directories
 * are skipped: discovery never throws.
 *
 * @param sessionsRoot - absolute sessions directory.
 * @param deps - injectable `{ readdir }` (tests).
 * @returns ascending `{ id, file }` entries; `id` is the session directory basename.
 */
export async function discoverLogs(sessionsRoot, deps = {}) {
  const listDirectory = typeof deps.readdir === 'function' ? deps.readdir : readdir
  const byId = new Map()
  const walk = async (directory) => {
    let entries
    try {
      entries = await listDirectory(directory, { withFileTypes: true })
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (entry === null || entry === undefined || typeof entry.name !== 'string') continue
      const full = path.join(directory, entry.name)
      if (typeof entry.isDirectory === 'function' && entry.isDirectory()) {
        await walk(full)
        continue
      }
      const isFile = typeof entry.isFile === 'function' ? entry.isFile() : false
      if (!isFile) continue
      const rank = LOG_NAMES.indexOf(entry.name)
      if (rank === -1) continue
      const id = path.basename(directory)
      const previous = byId.get(id)
      if (previous === undefined || rank < previous.rank) byId.set(id, { id, file: full, rank })
    }
  }
  await walk(sessionsRoot)
  return [...byId.values()]
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .map(({ id, file }) => ({ id, file }))
}

/**
 * Build (incrementally refresh) the usage index.
 *
 * Flow: discover logs → stat each → reuse the cached entry when `file`, `size`
 * and `mtimeMs` all match → otherwise read + fold (skipping corrupt/unreadable
 * files, counted in `skipped`) → drop sessions whose logs disappeared → write
 * atomically, but only when something actually changed.
 *
 * All filesystem work goes through `deps` so tests can drive the whole flow
 * with an in-memory store.
 *
 * @param options - `{ dshHome, sessionsRoot, cacheFile, tzOffsetMinutes, now,
 *   readFile, readdir, stat, writeFile, mkdir, rename, rm }`.
 * @returns `{ index, stats, buildMs, cacheFile, wroteCache, writeError }`.
 *   Cache write failures are reported, never thrown: the route still serves a
 *   fresh in-memory index.
 */
export async function buildIndex(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const startedAt = now()
  const tzOffsetMinutes = Number.isInteger(options.tzOffsetMinutes) ? options.tzOffsetMinutes : currentTzOffsetMinutes()
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : resolveDshHome()
  const sessionsRoot = typeof options.sessionsRoot === 'string' && options.sessionsRoot !== ''
    ? options.sessionsRoot
    : path.join(dshHome, SESSIONS_RELATIVE_PATH)
  const cacheFile = typeof options.cacheFile === 'string' && options.cacheFile !== ''
    ? options.cacheFile
    : path.join(dshHome, CACHE_RELATIVE_PATH)
  const deps = {
    readFile: typeof options.readFile === 'function' ? options.readFile : readFile,
    readdir: typeof options.readdir === 'function' ? options.readdir : readdir,
    stat: typeof options.stat === 'function' ? options.stat : stat,
    writeFile: typeof options.writeFile === 'function' ? options.writeFile : writeFile,
    mkdir: typeof options.mkdir === 'function' ? options.mkdir : mkdir,
    rename: typeof options.rename === 'function' ? options.rename : rename,
    rm: typeof options.rm === 'function' ? options.rm : rm,
  }

  let previous = null
  const cacheText = await readIndexText(cacheFile, deps.readFile)
  if (cacheText !== null) {
    try {
      previous = parseIndex(JSON.parse(cacheText), tzOffsetMinutes)
    } catch {
      previous = null
    }
  }
  const priorSessions = previous === null ? {} : previous.sessions

  const logs = await discoverLogs(sessionsRoot, { readdir: deps.readdir })
  const nextSessions = {}
  let scanned = 0
  let reused = 0
  let skipped = 0

  for (const log of logs) {
    let info
    try {
      // Stat BEFORE reading: a log that grows while we read it is picked up by
      // the next build instead of being cached with a mismatched size/mtime.
      info = await deps.stat(log.file)
    } catch {
      skipped += 1
      continue
    }
    if (info === null || info === undefined || typeof info.size !== 'number' || typeof info.mtimeMs !== 'number') {
      skipped += 1
      continue
    }
    const cached = priorSessions[log.id]
    if (
      cached !== undefined
      && cached.file === log.file
      && cached.size === info.size
      && cached.mtimeMs === info.mtimeMs
    ) {
      nextSessions[log.id] = cached
      reused += 1
      continue
    }
    let folded
    try {
      const raw = await deps.readFile(log.file)
      // `.jsonl` is the uncompressed fallback format: fold it as text, never
      // feed plaintext to the Zstandard frame scanner.
      folded = log.file.endsWith('.jsonl')
        ? foldSessionText(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'), { tzOffsetMinutes })
        : foldSessionBuffer(raw, { tzOffsetMinutes })
    } catch {
      skipped += 1
      continue
    }
    nextSessions[log.id] = {
      file: log.file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      createdAt: folded.createdAt,
      cwd: folded.cwd,
      category: folded.category,
      models: folded.models,
      providers: folded.providers,
      days: folded.days,
    }
    scanned += 1
  }

  const sessions = {}
  for (const id of Object.keys(nextSessions).sort()) sessions[id] = nextSessions[id]
  const removed = previous === null ? 0 : Object.keys(priorSessions).filter((id) => !(id in sessions)).length
  const index = {
    version: INDEX_VERSION,
    tzOffsetMinutes,
    createdAt: previous !== null && previous.createdAt > 0 ? previous.createdAt : toNonNegativeInt(startedAt),
    sessions,
  }
  const dirty = previous === null || scanned > 0 || removed > 0
  let writeError = null
  if (dirty) {
    try {
      await writeIndexFile(cacheFile, index, deps)
    } catch (error) {
      writeError = errorMessage(error)
    }
  }
  const files = logs.length
  return {
    index,
    stats: { sessions: Object.keys(sessions).length, scanned, reused, skipped, files, removed },
    buildMs: Math.max(0, now() - startedAt),
    cacheFile,
    wroteCache: dirty && writeError === null,
    writeError,
  }
}

// ---------------------------------------------------------------------------
// Report aggregation
// ---------------------------------------------------------------------------

/** Sanitize a cached usage array; `null` when it is not a four-bucket row. */
function bucketOfArray(values) {
  if (!Array.isArray(values) || values.length < 4) return null
  return {
    input: toNonNegativeInt(values[0]),
    output: toNonNegativeInt(values[1]),
    cacheRead: toNonNegativeInt(values[2]),
    cacheWrite: toNonNegativeInt(values[3]),
  }
}

/**
 * Aggregate the index over one day range into the frozen §4.3 response shape.
 *
 * Pure: `now` and `tzOffsetMinutes` are injectable so range boundaries and
 * daily zero-fill are deterministic in tests.
 *
 * @param index - a (validated) index, typically from {@link buildIndex}.
 * @param options - `{ days, now, generatedAt, tzOffsetMinutes, stats, buildMs }`.
 * @returns the JSON payload served by {@link ROUTE}.
 */
export function aggregateReport(index, options = {}) {
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const generatedAt = typeof options.generatedAt === 'number' && Number.isFinite(options.generatedAt)
    ? options.generatedAt
    : now
  const days = normalizeDays(options.days)
  const tzOffsetMinutes = Number.isInteger(options.tzOffsetMinutes)
    ? options.tzOffsetMinutes
    : isObject(index) && Number.isInteger(index.tzOffsetMinutes)
      ? index.tzOffsetMinutes
      : currentTzOffsetMinutes()
  const range = rangeDays(days, now, tzOffsetMinutes)

  const categories = {}
  for (const category of CATEGORIES) categories[category] = emptyCategoryBucket()
  const totals = emptyCategoryBucket()
  const categorySessions = new Map(CATEGORIES.map((category) => [category, new Set()]))
  const daily = range.list.map((day) => {
    const row = { day, categories: {}, models: {} }
    for (const category of CATEGORIES) row.categories[category] = emptyUsageBucket()
    return row
  })
  const dailyByDay = new Map(daily.map((row) => [row.day, row]))
  const modelTotals = new Map()
  const webByModel = new Map()

  const sessions = isObject(index) && isObject(index.sessions) ? index.sessions : {}
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (!isObject(session)) continue
    const category = CATEGORIES.includes(session.category) ? session.category : 'chat'
    const sessionDays = isObject(session.days) ? session.days : {}
    let sessionHasTokens = false
    for (const [day, raw] of Object.entries(sessionDays)) {
      const row = dailyByDay.get(day)
      if (row === undefined || !isObject(raw)) continue
      if (isObject(raw.usage)) {
        for (const [model, values] of Object.entries(raw.usage)) {
          if (typeof model !== 'string' || model === '') continue
          const bucket = bucketOfArray(values)
          if (bucket === null) continue
          if (bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite <= 0) continue
          addUsageBucket(categories[category], bucket)
          addUsageBucket(totals, bucket)
          addUsageBucket(row.categories[category], bucket)
          let dayModel = row.models[model]
          if (dayModel === undefined) {
            dayModel = emptyUsageBucket()
            row.models[model] = dayModel
          }
          addUsageBucket(dayModel, bucket)
          let entry = modelTotals.get(model)
          if (entry === undefined) {
            entry = { model, providers: new Set(), bucket: emptyUsageBucket(), sessions: new Set(), webSearches: 0 }
            modelTotals.set(model, entry)
          }
          addUsageBucket(entry.bucket, bucket)
          entry.sessions.add(sessionId)
          const providers = isObject(session.providers) && Array.isArray(session.providers[model])
            ? session.providers[model]
            : []
          for (const provider of providers) {
            if (typeof provider === 'string' && provider !== '') entry.providers.add(provider)
          }
          sessionHasTokens = true
        }
      }
      const web = toNonNegativeInt(raw.web)
      if (web > 0) {
        categories[category].webSearches += web
        totals.webSearches += web
      }
      if (isObject(raw.webByModel)) {
        for (const [model, count] of Object.entries(raw.webByModel)) {
          const hits = toNonNegativeInt(count)
          if (hits <= 0) continue
          webByModel.set(model, (webByModel.get(model) || 0) + hits)
        }
      }
    }
    if (sessionHasTokens) {
      categorySessions.get(category).add(sessionId)
      totals.sessions += 1
    }
  }
  for (const category of CATEGORIES) categories[category].sessions = categorySessions.get(category).size
  for (const [model, hits] of webByModel) {
    const entry = modelTotals.get(model)
    if (entry !== undefined) entry.webSearches = hits
  }

  const models = [...modelTotals.values()]
    .map((entry) => ({
      model: entry.model,
      providers: [...entry.providers].sort(),
      input: entry.bucket.input,
      output: entry.bucket.output,
      cacheRead: entry.bucket.cacheRead,
      cacheWrite: entry.bucket.cacheWrite,
      webSearches: entry.webSearches,
      sessions: entry.sessions.size,
    }))
    .sort((left, right) => {
      const delta = right.input + right.output - (left.input + left.output)
      return delta !== 0 ? delta : left.model < right.model ? -1 : left.model > right.model ? 1 : 0
    })

  const stats = isObject(options.stats) ? options.stats : {}
  const sessionCount = Object.keys(sessions).length
  return {
    ok: true,
    generatedAt,
    buildMs: toNonNegativeInt(options.buildMs),
    days,
    range: { from: range.from, to: range.to },
    tzOffsetMinutes,
    index: {
      sessions: toNonNegativeInt(stats.sessions !== undefined ? stats.sessions : sessionCount),
      scanned: toNonNegativeInt(stats.scanned),
      reused: toNonNegativeInt(stats.reused),
      skipped: toNonNegativeInt(stats.skipped),
      files: toNonNegativeInt(stats.files !== undefined ? stats.files : sessionCount),
    },
    categories,
    totals,
    models,
    daily,
  }
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

/**
 * Create a coalescing index loader.
 *
 * All callers that share ONE loader also share one in-flight build: the 4 s
 * activation warm-up and the first page request cannot start two concurrent
 * full scans. A loader serialises only while a build is in flight; once it
 * settles, the next call starts a fresh build so polling always sees new data.
 *
 * @param options - `{ buildIndex, buildOptions }` (injectable for tests).
 * @returns `() => Promise<build result>`.
 */
export function createIndexLoader(options = {}) {
  const build = typeof options.buildIndex === 'function' ? options.buildIndex : buildIndex
  const buildOptions = isObject(options.buildOptions) ? options.buildOptions : {}
  let pending = null
  return function loadIndex() {
    if (pending === null) {
      pending = Promise.resolve()
        .then(() => build(buildOptions))
        .finally(() => {
          pending = null
        })
    }
    return pending
  }
}

/**
 * Build the report route handler for `GET|HEAD /dsh-usage-stats/report`.
 *
 * The handler is total: wrong methods answer 405, every internal failure
 * answers 500 JSON, and it never rejects to the web server. Concurrent requests
 * share one in-flight index build through the loader.
 *
 * @param options - `{ loadIndex, buildIndex, buildOptions, now, warn }`
 *   (injectable for tests; `warn` is accepted for symmetry with warmIndex).
 */
export function createReportHandler(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const loadIndex = typeof options.loadIndex === 'function' ? options.loadIndex : createIndexLoader(options)

  return async function handleReport(request, response) {
    try {
      const method = request !== null && request !== undefined && typeof request.method === 'string'
        ? request.method
        : 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          if (response !== null && response !== undefined && typeof response.writeHead === 'function') {
            response.writeHead(405, { allow: 'GET, HEAD' })
            response.end()
          }
        } catch {
          /* responding is best-effort; never throw into the server */
        }
        return
      }
      let days = DEFAULT_RANGE_DAYS
      try {
        const rawUrl = request !== null && request !== undefined && typeof request.url === 'string' ? request.url : ROUTE
        const url = new URL(rawUrl, 'http://localhost')
        const rawDays = url.searchParams.get('days')
        if (rawDays !== null) days = normalizeDays(rawDays)
      } catch {
        days = DEFAULT_RANGE_DAYS
      }
      const result = await loadIndex()
      if (!isObject(result) || !isObject(result.index)) throw new Error('usage-stats: index builder returned no index')
      const tzOffsetMinutes = Number.isInteger(result.index.tzOffsetMinutes)
        ? result.index.tzOffsetMinutes
        : currentTzOffsetMinutes()
      const generatedAt = clock()
      const payload = aggregateReport(result.index, {
        days,
        now: generatedAt,
        generatedAt,
        tzOffsetMinutes,
        stats: result.stats,
        buildMs: result.buildMs,
      })
      const body = JSON.stringify(payload)
      if (response === null || response === undefined || typeof response.writeHead !== 'function') return
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(method === 'HEAD' ? undefined : body)
    } catch (error) {
      try {
        if (response !== null && response !== undefined && typeof response.writeHead === 'function') {
          response.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          response.end(JSON.stringify({ ok: false, error: errorMessage(error) }))
        }
      } catch {
        /* responding is best-effort; never throw into the server */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Log a warning through the plugin context without ever letting logging throw. */
function warnContext(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch {
    /* logging must never break activation or request handling */
  }
}

/**
 * Warm the index once, in the background. Failures only warn (SPEC §4.3).
 *
 * `options.loadIndex` lets the activation path pass the SAME coalescing loader
 * the report route uses, so a first page request that races the 4 s warm-up
 * joins one build instead of starting a second full scan.
 *
 * @param ctx - host plugin context (used for logging only).
 * @param options - `{ loadIndex, buildIndex, buildOptions }` (injectable for tests).
 * @returns the index, or `null` after a failure.
 */
export async function warmIndex(ctx, options = {}) {
  try {
    const loadIndex = typeof options.loadIndex === 'function'
      ? options.loadIndex
      : createIndexLoader(options)
    const result = await loadIndex()
    return isObject(result) ? result.index : null
  } catch (error) {
    warnContext(ctx, `usage-stats: index prewarm failed: ${errorMessage(error)}`)
    return null
  }
}

/**
 * Register the report route and the background index warm-up.
 *
 * Both registrations are optional and defensive: a context without `inject`,
 * without `effect`, or a web server that throws while registering only produces
 * a warning. The plugin must never fail activation.
 *
 * Route requests and the warm-up timer share one index loader, so the first
 * page load never races the timer into two concurrent full scans.
 *
 * @param ctx - host plugin context.
 * @param options - `{ loadIndex }`; reserved for tests, ignored by DSH.
 */
export function apply(ctx, options = {}) {
  const loadIndex = isObject(options) && typeof options.loadIndex === 'function'
    ? options.loadIndex
    : createIndexLoader()
  // Route: registered only when the webServer service becomes available.
  if (ctx !== null && ctx !== undefined && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (hostCtx) => {
        try {
          if (hostCtx === null || hostCtx === undefined || typeof hostCtx.effect !== 'function') {
            warnContext(ctx, 'usage-stats: host context lacks effect(); report route not registered')
            return
          }
          hostCtx.effect(() => {
            try {
              if (hostCtx.webServer === null || hostCtx.webServer === undefined) {
                warnContext(ctx, 'usage-stats: webServer service unavailable; report route not registered')
                return () => {}
              }
              return hostCtx.webServer.register({
                kind: 'exact',
                path: ROUTE,
                handler: createReportHandler({ loadIndex }),
              })
            } catch (error) {
              warnContext(ctx, `usage-stats: report route registration failed: ${errorMessage(error)}`)
              return () => {}
            }
          }, 'usage-stats: report route')
        } catch (error) {
          warnContext(ctx, `usage-stats: report route setup failed: ${errorMessage(error)}`)
        }
      })
    } catch (error) {
      warnContext(ctx, `usage-stats: webServer injection failed: ${errorMessage(error)}`)
    }
  } else {
    warnContext(ctx, 'usage-stats: context has no inject service; report route not registered')
  }

  // Warm-up: one index build 4 s after activation, owned and cleaned by effect.
  // It joins the route's loader so the two can never scan in parallel.
  const schedule = () => setTimeout(() => {
    void warmIndex(ctx, { loadIndex })
  }, WARMUP_DELAY_MS)
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const timer = schedule()
        return () => clearTimeout(timer)
      }, 'usage-stats: index warmup')
    } else {
      schedule()
    }
  } catch (error) {
    warnContext(ctx, `usage-stats: index warmup could not be scheduled: ${errorMessage(error)}`)
  }
}

/** True when a basename looks like a session directory (`session-<uuid>`); used by tests/docs. */
export function isSessionDirectory(name) {
  return typeof name === 'string' && SESSION_DIR_PATTERN.test(name)
}