/**
 * @ruaibeite/dsh-usage-stats — browser half.
 *
 * One page in Settings: 「用量 / Usage」. It folds every session on this device
 * into two scene cards (Chat and Code), a tokens-per-day bar chart and
 * a per-model breakdown. The numbers come from the plugin's own host route
 * (`GET /dsh-usage-stats/report`), which reads the local session logs; this
 * half only renders them, switches the 7/30/90 day range, switches the chart
 * between scenes and models, and polls quietly for fresh numbers.
 *
 * No prompt, no tool, no model call and no session write is added by this
 * plugin; the page never leaves its own slot in the settings panel.
 */
window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-usage-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@ruaibeite/dsh-usage-stats'

    // ---- identity & tuning ---------------------------------------------
    /** Host route serving the aggregated report. */
    const ROUTE = '/dsh-usage-stats/report'
    /** Selectable ranges, in days. */
    const RANGES = [7, 30, 90]
    /** Scene keys, in card order. */
    const CATEGORIES = ['chat', 'code']
    /** Chart series cap before the rest is merged into "其他". */
    const MODEL_SERIES_CAP = 6
    /** Quiet refresh cadence while the page is mounted. */
    const POLL_MS = 10000
    /** Chart geometry. */
    const CHART_HEIGHT = 240

    // ---- copy (bundled fallback; the locale service supplies the real one) --
    const TEXT = {
      zh: {
        'meta.title': '用量统计',
        'meta.description': '本机 Token 用量：Chat / Code 两张场景卡片、每日柱状图与按模型明细，全部推导自本地会话日志。',
        'nav': '用量',
        'title': '用量统计',
        'subtitle': '本设备的 Token 用量，分 Chat 与 Code。费用不显示 —— 计费以服务商账单为准。',
        'summary.sessions': '{n} 个会话',
        'summary.models': '{n} 个模型',
        'summary.cacheHit': '缓存命中率 {pct}',
        'range.7': '7 天',
        'range.30': '30 天',
        'range.90': '90 天',
        'cat.chat': 'Chat',
        'cat.code': 'Code',
        'cat.chatHint': '对话',
        'cat.codeHint': '代码执行',
        'metric.input': '未缓存输入',
        'metric.output': '输出',
        'metric.cacheRead': '缓存读',
        'metric.cacheWrite': '缓存写',
        'metric.io': '输入 + 输出 token',
        'webSearches': '{n} 次联网搜索',
        'sourcesNote': '服务商账单覆盖整个组织并计入缓存 token，因此与这里的合计不一致。',
        'chart.title': '每日 Token',
        'chart.descCategory': '最近 {n} 天，按场景统计的输入与输出 token',
        'chart.descModel': '最近 {n} 天，按模型统计的输入与输出 token',
        'chart.aria': '每日 Token 柱状图',
        'chart.empty': '这段时间还没有用量',
        'chart.other': '其他',
        'chart.total': '合计',
        'group.category': '场景',
        'group.model': '模型',
        'group.label': '图表分组',
        'table.title': '按模型',
        'table.desc': '最近 {n} 天，按模型汇总（同一模型跨供应商合并）',
        'table.model': '模型',
        'table.io': '输入 + 输出',
        'table.input': '输入',
        'table.output': '输出',
        'table.cacheRead': '缓存读',
        'table.share': '占比',
        'table.total': '合计',
        'table.empty': '还没有模型数据',
        'state.loading': '正在汇总本机会话…',
        'state.loadingHint': '首次打开需要扫描本机会话日志，约 5–10 秒；之后只读增量。',
        'state.error': '读取用量失败',
        'state.retry': '重试',
        'state.refreshing': '刷新中…',
        'state.stale': '刷新失败，显示上次结果',
        'footer.refresh': '刷新',
        'footer.note': '由本机会话日志推导：不新增提示词、不调用模型、不写入会话。',
        'footer.updatedAt': '更新于 {time}',
        'footer.indexed': '已索引 {n} 个会话',
        'unknown': '未知模型',
      },
      en: {
        'meta.title': 'Usage stats',
        'meta.description': 'Local token usage: Chat and Code scene cards, tokens per day and a per-model breakdown, all folded from the local session logs.',
        'nav': 'Usage',
        'title': 'Usage',
        'subtitle': "Token usage on this device, split into Chat and Code. Costs aren't shown — your provider bills you at its own rates.",
        'summary.sessions': '{n} sessions',
        'summary.models': '{n} models',
        'summary.cacheHit': '{pct} cache hits',
        'range.7': '7d',
        'range.30': '30d',
        'range.90': '90d',
        'cat.chat': 'Chat',
        'cat.code': 'Code',
        'cat.chatHint': 'conversation',
        'cat.codeHint': 'code & tools',
        'metric.input': 'Uncached input',
        'metric.output': 'Output',
        'metric.cacheRead': 'Cache read',
        'metric.cacheWrite': 'Cache write',
        'metric.io': 'input + output tokens',
        'webSearches': '{n} web searches',
        'sourcesNote': "Your provider's bill covers your whole organization and charges for cached tokens, so it won't match these totals.",
        'chart.title': 'Tokens per day',
        'chart.descCategory': 'Input and output tokens by scene, last {n} days',
        'chart.descModel': 'Input and output tokens by model, last {n} days',
        'chart.aria': 'Daily token bar chart',
        'chart.empty': 'No usage in this period yet',
        'chart.other': 'Other',
        'chart.total': 'Total',
        'group.category': 'Scene',
        'group.model': 'Model',
        'group.label': 'Chart grouping',
        'table.title': 'By model',
        'table.desc': 'Last {n} days, grouped by model (the same model is merged across providers)',
        'table.model': 'Model',
        'table.io': 'Input + output',
        'table.input': 'Input',
        'table.output': 'Output',
        'table.cacheRead': 'Cache read',
        'table.share': 'Share',
        'table.total': 'Total',
        'table.empty': 'No model data yet',
        'state.loading': "Summing up this device's sessions…",
        'state.loadingHint': 'The first open scans the local session logs (about 5–10 s); later opens only read what changed.',
        'state.error': 'Could not read usage',
        'state.retry': 'Retry',
        'state.refreshing': 'Refreshing…',
        'state.stale': 'Refresh failed; showing the last result',
        'footer.refresh': 'Refresh',
        'footer.note': 'Derived from the local session logs: no prompt, no model call, no session write.',
        'footer.updatedAt': 'Updated {time}',
        'footer.indexed': '{n} sessions indexed',
        'unknown': 'Unknown model',
      },
    }

    // ---- small helpers ---------------------------------------------------
    /** Whether the page is currently Chinese. */
    function isChinese() {
      try {
        const lang = (document.documentElement && document.documentElement.lang) || ''
        const nav = typeof navigator === 'object' && navigator !== null ? navigator.language || '' : ''
        return /^zh/i.test(lang) || /^zh/i.test(nav)
      } catch {
        return false
      }
    }

    /**
     * The active client locale id (`zh`, `en`, …), read from the locale service
     * when available. The bundled fallback is the document/navigator language,
     * which is only right when the locale service cannot be read.
     */
    function activeLanguage(ctx) {
      try {
        const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined
        if (locale !== null && locale !== undefined) {
          const snapshot = typeof locale.getLocale === 'function'
            ? locale.getLocale()
            : typeof locale.getSnapshot === 'function'
              ? locale.getSnapshot()
              : null
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string' && snapshot.active !== '') {
            return snapshot.active
          }
        }
      } catch {
        /* locale service unavailable: fall through */
      }
      try {
        const lang = (document.documentElement && document.documentElement.lang) || ''
        const nav = typeof navigator === 'object' && navigator !== null ? navigator.language || '' : ''
        return /^zh/i.test(lang) || /^zh/i.test(nav) ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /** Whether the rendered page should speak Chinese. */
    function pageIsChinese(props) {
      try {
        if (props !== null && props !== undefined && typeof props.getLanguage === 'function') {
          const lang = props.getLanguage()
          if (typeof lang === 'string' && lang !== '') return /^zh/i.test(lang)
        }
      } catch {
        /* fall through to the document language */
      }
      return isChinese()
    }

    /** Whether the page prefers reduced motion. */
    function reducedMotion() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }

    /** Locale lookup with a bundled fallback table. */
    function textOf(t, zh) {
      const table = zh ? TEXT.zh : TEXT.en
      return (key, params) => {
        let value
        if (typeof t === 'function') {
          try {
            const translated = t(key)
            if (typeof translated === 'string' && translated !== '' && translated !== key) value = translated
          } catch {
            /* locale service unavailable: use the bundled copy */
          }
        }
        if (value === undefined) {
          value = table[key]
          if (value === undefined) value = TEXT.en[key]
        }
        if (typeof value !== 'string') return key
        return params === undefined ? value : format(value, params)
      }
    }

    /** Replace `{name}` placeholders in a template. */
    function format(template, params) {
      if (params === null || typeof params !== 'object') return template
      return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
      )
    }

    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const nonNegative = (value) => Math.max(0, num(value))
    const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

    /** Compact token count: 0 / 942 / 37.6K / 11.6M / 1.2B. */
    function fmtTokens(value) {
      const n = nonNegative(value)
      if (n === 0) return '0'
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) {
        const thousands = n / 1e3
        return (thousands >= 999.5 ? oneDecimal(n / 1e6) + 'M' : oneDecimal(thousands) + 'K')
      }
      if (n < 1e9) {
        const millions = n / 1e6
        return (millions >= 999.5 ? oneDecimal(n / 1e9) + 'B' : oneDecimal(millions) + 'M')
      }
      return oneDecimal(n / 1e9) + 'B'
    }

    /** One decimal, dropping a trailing `.0`; integers above 100 stay whole. */
    function oneDecimal(value) {
      if (value >= 100) return String(Math.round(value))
      const fixed = value.toFixed(1)
      return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
    }

    /** Exact count with thousands separators, matching the reference page's rows. */
    function fmtExact(value) {
      const n = Math.round(nonNegative(value))
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Percentage with one decimal; `—` when the denominator is zero. */
    function fmtPct(value) {
      const n = num(value)
      return (n * 100).toFixed(1) + '%'
    }

    /** `HH:MM:SS` for a millisecond timestamp; `—` when unusable. */
    function fmtClock(ms, zh) {
      const t = num(ms)
      if (t <= 0) return '—'
      try {
        const date = new Date(t)
        const pad = (n) => String(n).padStart(2, '0')
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      } catch {
        return '—'
      }
    }

    const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    /** `2026-10-14` → `10-14` (zh) / `Oct 14` (en); bad input passes through. */
    function formatDayLabel(day, zh) {
      if (typeof day !== 'string') return ''
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
      if (match === null) return day
      const month = Number(match[2])
      const date = Number(match[3])
      if (zh) return match[2] + '-' + match[3]
      return (MONTHS_EN[month - 1] || match[2]) + ' ' + String(date)
    }

    /** Round a value up to a chart-friendly axis maximum. */
    function niceMax(value) {
      const n = Math.max(0, num(value))
      if (n === 0) return 0
      const exponent = Math.floor(Math.log10(n))
      const base = Math.pow(10, exponent)
      const fraction = n / base
      const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
      for (const step of steps) {
        if (fraction <= step + 1e-9) return step * base
      }
      return 10 * base
    }

    const bucketIo = (bucket) => nonNegative(bucket && bucket.input) + nonNegative(bucket && bucket.output)

    // ---- report parsing (defensive) -------------------------------------
    /** Normalize one `{input,output,cacheRead,cacheWrite}` bucket. */
    function normBucket(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      return {
        input: nonNegative(raw.input),
        output: nonNegative(raw.output),
        cacheRead: nonNegative(raw.cacheRead),
        cacheWrite: nonNegative(raw.cacheWrite),
      }
    }

    /** Normalize one category counter. */
    function normCategory(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      return { ...normBucket(raw), webSearches: nonNegative(raw.webSearches), sessions: nonNegative(raw.sessions) }
    }

    /** Normalize one model row. */
    function normModel(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      const providers = Array.isArray(raw.providers)
        ? [...new Set(raw.providers.filter((p) => typeof p === 'string' && p !== ''))].slice(0, 16)
        : []
      return {
        model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : 'unknown',
        providers,
        ...normBucket(raw),
        webSearches: nonNegative(raw.webSearches),
        sessions: nonNegative(raw.sessions),
      }
    }

    const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

    /** Normalize one daily row. */
    function normDay(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      const day = typeof raw.day === 'string' && DAY_RE.test(raw.day) ? raw.day : null
      const categories = {}
      for (const key of CATEGORIES) categories[key] = normBucket(raw.categories && raw.categories[key])
      const modelsRaw = raw.models !== null && typeof raw.models === 'object' ? raw.models : {}
      const models = {}
      let count = 0
      for (const model of Object.keys(modelsRaw)) {
        if (typeof model !== 'string' || model === '') continue
        models[model] = normBucket(modelsRaw[model])
        count += 1
        if (count >= 128) break
      }
      return { day, categories, models }
    }

    /**
     * Parse the host report into the shape every component expects.
     * Returns `null` for anything that is not a successful report, so the page
     * can show its error state instead of crashing on a half-written payload.
     */
    function parseReport(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      if (raw.ok !== true) return null
      const days = RANGES.indexOf(raw.days) === -1 ? 30 : raw.days
      const rangeRaw = raw.range !== null && typeof raw.range === 'object' ? raw.range : {}
      const from = typeof rangeRaw.from === 'string' && DAY_RE.test(rangeRaw.from) ? rangeRaw.from : ''
      const to = typeof rangeRaw.to === 'string' && DAY_RE.test(rangeRaw.to) ? rangeRaw.to : ''
      const categories = {}
      for (const key of CATEGORIES) categories[key] = normCategory(raw.categories && raw.categories[key])
      const totals = normCategory(raw.totals)
      const models = []
      if (Array.isArray(raw.models)) {
        for (const entry of raw.models.slice(0, 128)) {
          const model = normModel(entry)
          if (model.model !== 'unknown' || model.input + model.output > 0) models.push(model)
        }
      }
      const daily = []
      if (Array.isArray(raw.daily)) {
        for (const entry of raw.daily.slice(0, 400)) {
          const day = normDay(entry)
          if (day.day !== null) daily.push(day)
        }
      }
      if (daily.length === 0 && from !== '' && to !== '') {
        // The host normalizes a report even when every day is empty; keeping an
        // empty list is honest, the chart shows its empty state.
      }
      const indexRaw = raw.index !== null && typeof raw.index === 'object' ? raw.index : {}
      const index = {
        sessions: nonNegative(indexRaw.sessions),
        scanned: nonNegative(indexRaw.scanned),
        reused: nonNegative(indexRaw.reused),
        skipped: nonNegative(indexRaw.skipped),
        files: nonNegative(indexRaw.files),
      }
      return {
        ok: true,
        days,
        range: { from, to },
        generatedAt: nonNegative(raw.generatedAt),
        buildMs: nonNegative(raw.buildMs),
        index,
        categories,
        totals,
        models,
        daily,
      }
    }

    // ---- chart aggregation ----------------------------------------------
    /**
     * Aggregate the daily rows into one series list for the chart.
     *
     * Accepts either a parsed report (`{daily, models}`) or a bare daily array;
     * the bare form is what the no-browser tests use.
     *
     * @returns {{days: string[], series: Array<{key: string, values: number[]}>, max: number, total: number}}
     */
    function aggregateSeries(input, mode) {
      const daily = Array.isArray(input)
        ? input
        : input !== null && typeof input === 'object' && Array.isArray(input.daily)
          ? input.daily
          : []
      const knownModels = Array.isArray(input) ? [] : (Array.isArray(input.models) ? input.models : [])
      const days = daily.map((row) => (row && typeof row.day === 'string' ? row.day : ''))
      const series = []
      if (mode === 'model') {
        const totals = new Map()
        for (const row of daily) {
          const models = row && row.models && typeof row.models === 'object' ? row.models : {}
          for (const model of Object.keys(models)) {
            const value = bucketIo(models[model])
            totals.set(model, (totals.get(model) || 0) + value)
          }
        }
        const order = (knownModels.length > 0 ? knownModels.map((row) => row.model) : [...totals.keys()])
          .filter((model) => typeof model === 'string' && model !== '')
          .sort((left, right) => (totals.get(right) || 0) - (totals.get(left) || 0))
          .filter((model) => (totals.get(model) || 0) > 0)
        const top = order.slice(0, MODEL_SERIES_CAP)
        const rest = order.slice(MODEL_SERIES_CAP)
        const keys = top.slice()
        if (rest.length > 0) keys.push('other')
        for (const key of keys) {
          const values = daily.map((row) => {
            const models = row && row.models && typeof row.models === 'object' ? row.models : {}
            if (key === 'other') {
              let sum = 0
              for (const model of rest) sum += bucketIo(models[model])
              return sum
            }
            return bucketIo(models[key])
          })
          series.push({ key, values })
        }
      } else {
        for (const key of CATEGORIES) {
          const values = daily.map((row) => {
            const categories = row && row.categories && typeof row.categories === 'object' ? row.categories : {}
            return bucketIo(categories[key])
          })
          series.push({ key, values })
        }
      }
      let total = 0
      let max = 0
      for (let i = 0; i < daily.length; i += 1) {
        let dayTotal = 0
        for (const entry of series) dayTotal += entry.values[i] || 0
        total += dayTotal
        if (dayTotal > max) max = dayTotal
      }
      return { days, series, max, total }
    }

    /** Resolve the localized label of a chart series. */
    function seriesLabel(tr, key) {
      if (CATEGORIES.indexOf(key) !== -1) return tr('cat.' + key)
      if (key === 'other') return tr('chart.other')
      return key
    }

    /** Palette for model series; scene series use their fixed scene colours. */
    const MODEL_COLORS = [
      'var(--dsw-alias-state-business-primary, #4176e6)',
      'var(--dsw-alias-state-warn-primary, #f59e0b)',
      'var(--dsw-alias-state-success-primary, #22c55e)',
      'var(--dsw-alias-state-error-primary, #ec1313)',
      'var(--dsw-static-violet-600, #7c3aed)',
      'var(--dsw-static-blue-400, #60a5fa)',
      'var(--dsw-alias-label-tertiary, #8a8a8a)',
    ]
    const SCENE_COLORS = {
      chat: 'var(--dsw-alias-state-business-primary, #4176e6)',
      code: 'var(--dsw-alias-state-success-primary, #22c55e)',
    }

    /** Colour of one chart series. */
    function seriesColor(key, index, mode) {
      if (mode !== 'model' && SCENE_COLORS[key] !== undefined) return SCENE_COLORS[key]
      return MODEL_COLORS[index % MODEL_COLORS.length]
    }

    /** Cache hit ratio for the summary chips: cached prompt ÷ all prompt tokens. */
    function cacheHitRatio(totals) {
      const prompt = nonNegative(totals.input) + nonNegative(totals.cacheRead) + nonNegative(totals.cacheWrite)
      if (prompt <= 0) return 0
      return nonNegative(totals.cacheRead) / prompt
    }

    // ---- styles ----------------------------------------------------------
    const CSS = `
.us-root{display:flex;flex-direction:column;gap:14px;padding:2px 0 20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.us-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.us-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
.us-sub{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55}
.us-chips{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.us-seg{display:inline-flex;flex-shrink:0;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#00000005)}
.us-seg-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:3px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}
.us-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.us-seg-on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft,0 1px 2px #0000000d)}
.us-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.us-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.us-card{display:flex;flex-direction:column;min-width:0;padding:13px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff))}
.us-card-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.us-card-name{font-size:13.5px;font-weight:600}
.us-card-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.us-card-big{margin-top:6px;font-size:19px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.us-card-cap{margin-bottom:9px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.us-card-rows{display:flex;flex-direction:column;gap:4px}
.us-row{display:flex;justify-content:space-between;gap:6px;font-size:11.5px;line-height:16.5px}
.us-row-label{overflow:hidden;color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis}
.us-row-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.us-card-foot{margin-top:10px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.us-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.5}
.us-panel{display:flex;flex-direction:column;min-width:0;gap:10px;padding:13px 14px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff))}
.us-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.us-panel-title{margin:0;font-size:15px;font-weight:600}
.us-panel-desc{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.5}
.us-legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.us-legend-item{display:inline-flex;align-items:center;gap:6px}
.us-dot{flex-shrink:0;width:9px;height:9px;border-radius:3px}
.us-chart-wrap{position:relative;margin-top:2px}
.us-chart-svg{display:block;width:100%}
.us-tooltip{position:absolute;z-index:4;min-width:150px;max-width:230px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:var(--dsw-elevation-panel,0 4px 16px #0000001a);font-size:11.5px;pointer-events:none}
.us-tooltip-day{margin-bottom:5px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.us-tooltip-row{display:flex;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary);line-height:17px}
.us-tooltip-row b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.us-tooltip-total{display:flex;justify-content:space-between;margin-top:5px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.us-table{overflow-x:auto}
.us-table-inner{display:flex;flex-direction:column;min-width:430px}
.us-tr{display:grid;grid-template-columns:minmax(150px,1fr) 104px 96px 116px;gap:8px;align-items:center;padding:7px 1px;border-top:1px solid var(--dsw-alias-border-l1)}
.us-th{padding-bottom:3px;border-top:none;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.us-num{text-align:right;color:var(--dsw-alias-label-primary);font-size:11.5px;font-variant-numeric:tabular-nums}
.us-model{min-width:0}
.us-model-name{overflow:hidden;font-size:12px;font-weight:500;white-space:nowrap;text-overflow:ellipsis}
.us-model-providers{overflow:hidden;margin-top:1px;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;text-overflow:ellipsis}
.us-share{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.us-share-bar{flex-shrink:0;width:44px;height:4px;overflow:hidden;border-radius:2px;background:var(--dsw-alias-border-l1)}
.us-share-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary,#4176e6)}
.us-share-pct{min-width:38px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.us-tr-total{font-weight:600}
.us-tr-total .us-num,.us-tr-total .us-model-name{font-weight:600}
.us-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.us-foot-right{display:flex;align-items:center;gap:10px}
.us-refresh{appearance:none;border:none;background:transparent;color:var(--dsw-alias-link,#4176e6);font:inherit;font-size:11px;cursor:pointer;padding:2px 0}
.us-refresh:hover{text-decoration:underline}
.us-refresh:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;text-decoration:none}
.us-stale{color:var(--dsw-alias-state-warn-label,#b45309)}
.us-empty{padding:34px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.us-skeleton{display:flex;flex-direction:column;gap:16px}
.us-skeleton-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.us-skeleton-card{height:178px;border-radius:12px;background:var(--dsw-alias-bg-skeleton,#0000000a);overflow:hidden}
.us-skeleton-chart{height:250px;border-radius:12px;background:var(--dsw-alias-bg-skeleton,#0000000a)}
.us-skeleton-card::after,.us-skeleton-chart::after{content:"";display:block;width:40%;height:100%;background:linear-gradient(90deg,transparent,var(--dsw-alias-interactive-bg-hover,#00000008),transparent);animation:us-shimmer 1.4s linear infinite}
.us-loading{display:flex;flex-direction:column;align-items:center;gap:8px;padding:38px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.us-loading-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.us-spinner{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,#4176e6);border-radius:50%;animation:us-spin .9s linear infinite}
.us-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:34px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.us-error-detail{max-width:420px;color:var(--dsw-alias-label-tertiary);font-size:11px;word-break:break-word}
.us-retry{appearance:none;margin-top:4px;padding:4px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.us-retry:hover{background:var(--dsw-alias-interactive-bg-hover,#00000008)}
.us-icon{display:block}
@keyframes us-spin{to{transform:rotate(360deg)}}
@keyframes us-shimmer{from{transform:translateX(-100%)}to{transform:translateX(350%)}}
@media (prefers-reduced-motion:reduce){.us-spinner{animation:none}.us-skeleton-card::after,.us-skeleton-chart::after{animation:none}}
`

    // ---- data loading ----------------------------------------------------
    /** Fetch one report for a range, rejecting on transport or shape errors. */
    function fetchReport(days) {
      const route = ROUTE + '?days=' + encodeURIComponent(String(days))
      return fetch(route, { headers: { accept: 'application/json' } }).then((response) => {
        if (response === null || response === undefined || response.ok !== true) {
          throw new Error('HTTP ' + (response === null || response === undefined ? '?' : response.status))
        }
        return response.json()
      }).then((raw) => {
        const report = parseReport(raw)
        if (report === null) throw new Error('invalid usage report')
        return report
      })
    }

    // ---- shared widgets --------------------------------------------------
    /** Small segmented control used for the range and the chart grouping. */
    function Segmented(props) {
      const options = Array.isArray(props.options) ? props.options : []
      return h(
        'div',
        { className: 'us-seg', role: 'group', 'aria-label': props.label || '' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: 'us-seg-btn' + (option.value === props.value ? ' us-seg-on' : ''),
              'aria-pressed': option.value === props.value ? 'true' : 'false',
              'data-value': String(option.value),
              onClick: () => {
                if (typeof props.onChange === 'function' && option.value !== props.value) props.onChange(option.value)
              },
            },
            option.label,
          ),
        ),
      )
    }

    /** Sidebar section icon: three bars and a rising line. */
    function UsageIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h(
        'svg',
        { className: 'us-icon', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('rect', { x: 3.5, y: 12.5, width: 4, height: 7.5, rx: 1.2, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 10, y: 8.5, width: 4, height: 11.5, rx: 1.2, fill: 'currentColor', opacity: 0.78 }),
        h('rect', { x: 16.5, y: 4.5, width: 4, height: 15.5, rx: 1.2, fill: 'currentColor' }),
        h('path', {
          d: 'M5.5 9.5 12 6 18.5 2.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.9,
        }),
      )
    }

    /** Range selector header: title on the left, 7/30/90 days on the right. */
    function UsageHeader(props) {
      const tr = props.tr
      const days = RANGES.indexOf(props.days) === -1 ? 30 : props.days
      return h(
        'div',
        { className: 'us-head' },
        h('div', { style: { minWidth: 0 } }, h('h2', { className: 'us-title' }, tr('title'))),
        h(Segmented, {
          value: days,
          label: tr('title'),
          options: RANGES.map((value) => ({ value, label: tr('range.' + value) })),
          onChange: (value) => {
            if (typeof props.onDays === 'function') props.onDays(value)
          },
        }),
      )
    }

    /** One label/value row inside a scene card. */
    function MetricRow(props) {
      return h(
        'div',
        { className: 'us-row' },
        h('span', { className: 'us-row-label' }, props.label),
        h('span', { className: 'us-row-value', title: fmtExact(props.value) }, fmtExact(props.value)),
      )
    }

    /** The three scene cards. */
    function UsageCards(props) {
      const report = props.report
      const tr = props.tr
      return h(
        'div',
        { className: 'us-cards' },
        CATEGORIES.map((category) => {
          const bucket = report.categories[category]
          const io = bucket.input + bucket.output
          return h(
            'div',
            { key: category, className: 'us-card', 'data-cat': category },
            h(
              'div',
              { className: 'us-card-head' },
              h('span', { className: 'us-card-name' }, tr('cat.' + category)),
              h('span', { className: 'us-card-hint' }, tr('cat.' + category + 'Hint')),
            ),
            h('div', { className: 'us-card-big', 'data-io': String(io) }, fmtTokens(io)),
            h('div', { className: 'us-card-cap' }, tr('metric.io')),
            h(
              'div',
              { className: 'us-card-rows' },
              h(MetricRow, { label: tr('metric.input'), value: bucket.input }),
              h(MetricRow, { label: tr('metric.output'), value: bucket.output }),
              h(MetricRow, { label: tr('metric.cacheRead'), value: bucket.cacheRead }),
              h(MetricRow, { label: tr('metric.cacheWrite'), value: bucket.cacheWrite }),
            ),
            h('div', { className: 'us-card-foot' }, tr('webSearches', { n: fmtExact(bucket.webSearches) })),
          )
        }),
      )
    }

    /** Legend chips shared by both chart modes. */
    function ChartLegend(props) {
      const series = props.series
      const tr = props.tr
      const mode = props.mode
      return h(
        'div',
        { className: 'us-legend' },
        series.map((entry, index) =>
          h(
            'span',
            { key: entry.key, className: 'us-legend-item' },
            h('span', { className: 'us-dot', style: { background: seriesColor(entry.key, index, mode) } }),
            h('span', null, seriesLabel(tr, entry.key)),
          ),
        ),
      )
    }

    /** Tooltip body for one hovered day. */
    function ChartTooltip(props) {
      const tr = props.tr
      const mode = props.mode
      const series = props.series
      const index = props.index
      const zh = props.zh
      const rows = []
      let total = 0
      for (let s = 0; s < series.length; s += 1) {
        const value = series[s].values[index] || 0
        total += value
        if (value <= 0) continue
        rows.push(
          h(
            'div',
            { key: 'tip-' + series[s].key, className: 'us-tooltip-row' },
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('span', { className: 'us-dot', style: { background: seriesColor(series[s].key, s, mode) } }),
              h('span', null, seriesLabel(tr, series[s].key)),
            ),
            h('b', null, fmtTokens(value)),
          ),
        )
      }
      return h(
        'div',
        { className: 'us-tooltip', style: { left: props.left, top: props.top } },
        h('div', { className: 'us-tooltip-day' }, formatDayLabel(props.day, zh)),
        rows,
        h(
          'div',
          { className: 'us-tooltip-total' },
          h('span', null, tr('chart.total')),
          h('span', null, fmtTokens(total)),
        ),
      )
    }

    /** The tokens-per-day chart card (scene bars or stacked model bars). */
    function UsageChart(props) {
      const report = props.report
      const tr = props.tr
      const zh = props.zh
      const mode = props.mode === 'model' ? 'model' : 'category'
      const [width, setWidth] = React.useState(520)
      const [hovered, setHovered] = React.useState(null)
      const boxRef = React.useRef(null)
      const chart = aggregateSeries(report, mode)
      const axisMax = niceMax(chart.max)

      React.useEffect(() => {
        const element = boxRef.current
        if (!element || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const next = Math.round(entry.contentRect.width)
            if (next > 0) setWidth(next)
          }
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      const w = Math.max(300, Math.round(width))
      const plot = { left: 46, right: 6, top: 8, bottom: 24 }
      const innerWidth = w - plot.left - plot.right
      const innerHeight = CHART_HEIGHT - plot.top - plot.bottom
      const days = chart.days.length
      const groupWidth = days > 0 ? innerWidth / days : innerWidth

      const bars = []
      const overlays = []
      const axis = []
      const xlabels = []

      if (axisMax > 0 && days > 0) {
        const tickCount = 4
        for (let tick = 0; tick <= tickCount; tick += 1) {
          const value = (axisMax * tick) / tickCount
          const y = plot.top + innerHeight - (innerHeight * tick) / tickCount
          axis.push(
            h('g', { key: 'grid-' + tick },
              h('line', {
                x1: plot.left,
                x2: plot.left + innerWidth,
                y1: y,
                y2: y,
                stroke: 'var(--dsw-alias-border-l2, #0000001a)',
                strokeWidth: 1,
              }),
              h('text', {
                x: plot.left - 8,
                y: y + 3.5,
                textAnchor: 'end',
                fill: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                fontSize: 10,
              }, fmtTokens(value)),
            ),
          )
        }
      }

      if (axisMax > 0 && days > 0) {
        for (let index = 0; index < days; index += 1) {
          const groupX = plot.left + index * groupWidth
          const scale = (value) => (innerHeight * Math.max(0, value)) / axisMax
          if (mode === 'model') {
            const barWidth = clamp(groupWidth * 0.56, 2.5, 16)
            const barX = groupX + (groupWidth - barWidth) / 2
            let cursor = 0
            for (let s = 0; s < chart.series.length; s += 1) {
              const value = chart.series[s].values[index] || 0
              if (value <= 0) continue
              const height = scale(value)
              cursor += height
              bars.push(
                h('rect', {
                  key: 'bar-' + index + '-' + s,
                  x: barX,
                  y: plot.top + innerHeight - cursor,
                  width: barWidth,
                  height: Math.max(0.5, height),
                  fill: seriesColor(chart.series[s].key, s, mode),
                  opacity: hovered === null || hovered === index ? 1 : 0.55,
                  rx: 1,
                }),
              )
            }
          } else {
            const slots = Math.max(1, chart.series.length)
            const gap = Math.min(3, groupWidth * 0.045)
            const barWidth = clamp((groupWidth * 0.72 - gap * (slots - 1)) / slots, 1.5, 18)
            const groupInner = barWidth * slots + gap * (slots - 1)
            const barX = groupX + (groupWidth - groupInner) / 2
            for (let s = 0; s < chart.series.length; s += 1) {
              const value = chart.series[s].values[index] || 0
              const height = scale(value)
              bars.push(
                h('rect', {
                  key: 'bar-' + index + '-' + s,
                  x: barX + s * (barWidth + gap),
                  y: plot.top + innerHeight - height,
                  width: barWidth,
                  height: Math.max(0.5, height),
                  fill: seriesColor(chart.series[s].key, s, mode),
                  opacity: hovered === null || hovered === index ? 1 : 0.55,
                  rx: 1,
                }),
              )
            }
          }
          overlays.push(
            h('rect', {
              key: 'hover-' + index,
              x: groupX,
              y: plot.top,
              width: groupWidth,
              height: innerHeight,
              fill: 'transparent',
              pointerEvents: 'all',
              onMouseEnter: () => setHovered(index),
              onMouseLeave: () => setHovered((current) => (current === index ? null : current)),
            }),
          )
        }

        const step = Math.max(1, Math.ceil(days / 6))
        const tickIndices = []
        for (let index = 0; index < days; index += step) tickIndices.push(index)
        if (tickIndices[tickIndices.length - 1] !== days - 1) tickIndices.push(days - 1)
        for (const index of tickIndices) {
          const center = plot.left + index * groupWidth + groupWidth / 2
          const anchor = index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle'
          const x = index === 0 ? plot.left : index === days - 1 ? plot.left + innerWidth : center
          xlabels.push(
            h('text', {
              key: 'x-' + index,
              x,
              y: CHART_HEIGHT - 8,
              textAnchor: anchor,
              fill: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
              fontSize: 10,
            }, formatDayLabel(chart.days[index], zh)),
          )
        }
      }

      const tooltip = hovered !== null && hovered >= 0 && hovered < days && axisMax > 0
        ? h(ChartTooltip, {
            tr,
            zh,
            mode,
            series: chart.series,
            index: hovered,
            day: chart.days[hovered],
            left: clamp(plot.left + hovered * groupWidth + groupWidth / 2 - 92, 4, w - 200),
            top: 6,
          })
        : null

      return h(
        'div',
        { className: 'us-panel', 'data-mode': mode },
        h(
          'div',
          { className: 'us-panel-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h3', { className: 'us-panel-title' }, tr('chart.title')),
            h('div', { className: 'us-panel-desc' }, tr(mode === 'model' ? 'chart.descModel' : 'chart.descCategory', { n: report.days })),
          ),
          h(Segmented, {
            value: mode,
            label: tr('group.label'),
            options: [
              { value: 'category', label: tr('group.category') },
              { value: 'model', label: tr('group.model') },
            ],
            onChange: (value) => {
              if (typeof props.onMode === 'function') props.onMode(value)
            },
          }),
        ),
        chart.series.length > 0 ? h(ChartLegend, { series: chart.series, tr, mode }) : null,
        h(
          'div',
          {
            className: 'us-chart-wrap',
            ref: boxRef,
            role: 'img',
            'aria-label': tr('chart.aria') + ' · ' + tr(mode === 'model' ? 'chart.descModel' : 'chart.descCategory', { n: report.days }),
            'data-total': String(chart.total),
            'data-max': String(chart.max),
            'data-series': chart.series.map((entry) => entry.key + '=' + entry.values.reduce((sum, value) => sum + value, 0)).join(','),
          },
          axisMax > 0
            ? h(
                'svg',
                {
                  className: 'us-chart-svg',
                  width: w,
                  height: CHART_HEIGHT,
                  viewBox: '0 0 ' + w + ' ' + CHART_HEIGHT,
                  onMouseLeave: () => setHovered(null),
                  preserveAspectRatio: 'none',
                },
                axis,
                bars,
                overlays,
                xlabels,
              )
            : h('div', { className: 'us-empty' }, tr('chart.empty')),
          tooltip,
        ),
      )
    }

    /** The per-model breakdown table. */
    function ModelTable(props) {
      const report = props.report
      const tr = props.tr
      const models = report.models.slice()
      const modelIo = models.reduce((sum, model) => sum + model.input + model.output, 0)
      const reportIo = nonNegative(report.totals.input) + nonNegative(report.totals.output)
      const totalIo = reportIo > 0 ? reportIo : modelIo
      const maxIo = models.reduce((max, model) => Math.max(max, model.input + model.output), 0)
      const rows = []
      for (const model of models) {
        const io = model.input + model.output
        const share = totalIo > 0 ? io / totalIo : 0
        const barWidth = maxIo > 0 ? Math.max(2, Math.round((io / maxIo) * 100)) : 0
        rows.push(
          h(
            'div',
            { key: model.model, className: 'us-tr', 'data-model': model.model, 'data-io': String(io) },
            h(
              'div',
              { className: 'us-model' },
              h('div', { className: 'us-model-name', title: model.model }, model.model),
              model.providers.length > 0
                ? h('div', { className: 'us-model-providers', title: model.providers.join(', ') }, model.providers.join(' · '))
                : null,
            ),
            h(
              'div',
              {
                className: 'us-num',
                title: tr('table.input') + ' ' + fmtExact(model.input) + ' · ' + tr('table.output') + ' ' + fmtExact(model.output),
              },
              fmtExact(io),
            ),
            h('div', { className: 'us-num' }, fmtExact(model.cacheRead)),
            h(
              'div',
              { className: 'us-share' },
              h('div', { className: 'us-share-bar' }, h('div', { className: 'us-share-fill', style: { width: barWidth + '%' } })),
              h('span', { className: 'us-share-pct' }, fmtPct(share)),
            ),
          ),
        )
      }
      return h(
        'div',
        { className: 'us-panel', 'data-card': 'models' },
        h(
          'div',
          { className: 'us-panel-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h3', { className: 'us-panel-title' }, tr('table.title')),
            h('div', { className: 'us-panel-desc' }, tr('table.desc', { n: report.days })),
          ),
        ),
        models.length === 0
          ? h('div', { className: 'us-empty' }, tr('table.empty'))
          : h(
              'div',
              { className: 'us-table' },
              h(
                'div',
                { className: 'us-table-inner' },
                h(
                  'div',
                  { className: 'us-tr us-th' },
                  h('div', null, tr('table.model')),
                  h('div', { className: 'us-num' }, tr('table.io')),
                  h('div', { className: 'us-num' }, tr('table.cacheRead')),
                  h('div', { className: 'us-num' }, tr('table.share')),
                ),
                rows,
                h(
                  'div',
                  { className: 'us-tr us-tr-total', 'data-total': '1' },
                  h('div', { className: 'us-model' }, tr('table.total')),
                  h('div', { className: 'us-num' }, fmtExact(totalIo)),
                  h('div', { className: 'us-num' }, fmtExact(report.totals.cacheRead)),
                  h('div', { className: 'us-num' }, '100.0%'),
                ),
              ),
            ),
      )
    }

    /** The quiet footer: derivation note, refresh time and a refresh action. */
    function UsageFooter(props) {
      const tr = props.tr
      const report = props.report
      const zh = props.zh
      const time = props.updatedAt > 0 ? props.updatedAt : report.generatedAt
      return h(
        'div',
        { className: 'us-foot' },
        h(
          'span',
          null,
          tr('footer.note') + (report.index.sessions > 0 ? ' · ' + tr('footer.indexed', { n: fmtExact(report.index.sessions) }) : ''),
        ),
        h(
          'span',
          { className: 'us-foot-right' },
          props.stale ? h('span', { className: 'us-stale' }, tr('state.stale')) : null,
          h('span', null, tr('footer.updatedAt', { time: fmtClock(time) })),
          h(
            'button',
            {
              type: 'button',
              className: 'us-refresh',
              disabled: props.busy === true,
              onClick: () => {
                if (typeof props.onRefresh === 'function') props.onRefresh()
              },
            },
            props.busy === true ? tr('state.refreshing') : tr('footer.refresh'),
          ),
        ),
      )
    }

    /** First-load skeleton with a short explanation of the wait. */
    function LoadingState(props) {
      const tr = props.tr
      return h(
        'div',
        { className: 'us-skeleton' },
        h(
          'div',
          { className: 'us-loading' },
          h('div', { className: 'us-spinner', 'aria-hidden': true }),
          h('span', null, tr('state.loading')),
          h('span', { className: 'us-loading-hint' }, tr('state.loadingHint')),
        ),
        h('div', { className: 'us-skeleton-cards' }, CATEGORIES.map((key) => h('div', { key, className: 'us-skeleton-card' }))),
        h('div', { className: 'us-skeleton-chart' }),
      )
    }

    /** Failure state with the transport detail and a retry action. */
    function ErrorState(props) {
      const tr = props.tr
      return h(
        'div',
        { className: 'us-error' },
        h('span', null, tr('state.error')),
        props.detail ? h('span', { className: 'us-error-detail' }, String(props.detail)) : null,
        h(
          'button',
          {
            type: 'button',
            className: 'us-retry',
            onClick: () => {
              if (typeof props.onRetry === 'function') props.onRetry()
            },
          },
          tr('state.retry'),
        ),
      )
    }

    /** The whole Usage page mounted in the `settings.section` slot. */
    function UsageSection(props) {
      const zh = pageIsChinese(props)
      const tr = textOf(props.t, zh)
      const load = typeof props.fetchReport === 'function' ? props.fetchReport : fetchReport
      const [days, setDays] = React.useState(30)
      const [mode, setMode] = React.useState('category')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(true)
      const [stale, setStale] = React.useState(false)
      const [updatedAt, setUpdatedAt] = React.useState(0)
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        setBusy(true)
        setError(null)
        load(days)
          .then((report) => {
            if (!alive) return
            setData(report)
            setError(null)
            setStale(false)
            setUpdatedAt(Date.now())
          })
          .catch((failure) => {
            if (!alive) return
            setError(failure && failure.message ? failure.message : String(failure))
            setStale(true)
          })
          .finally(() => {
            if (alive) setBusy(false)
          })
        const timer = setInterval(() => {
          try {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          } catch {
            /* keep polling when visibility is unavailable */
          }
          load(days)
            .then((report) => {
              if (!alive) return
              setData(report)
              setError(null)
              setStale(false)
              setUpdatedAt(Date.now())
            })
            .catch(() => {
              if (alive) setStale(true)
            })
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [days, tick])

      const totals = data === null ? null : data.totals
      const chips = totals === null
        ? null
        : h(
            'div',
            { className: 'us-chips' },
            h('span', null, tr('summary.sessions', { n: fmtExact(totals.sessions) })),
            h('span', null, tr('summary.models', { n: fmtExact(data.models.length) })),
            h('span', null, tr('summary.cacheHit', { pct: fmtPct(cacheHitRatio(totals)) })),
          )

      const body = data !== null
        ? h(
            'div',
            { className: 'us-body', style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            h(UsageCards, { report: data, tr }),
            h('div', { className: 'us-note' }, tr('sourcesNote')),
            h(UsageChart, {
              report: data,
              tr,
              zh,
              mode,
              onMode: (value) => setMode(value),
            }),
            h(ModelTable, { report: data, tr }),
            h(UsageFooter, {
              report: data,
              tr,
              zh,
              stale,
              busy,
              updatedAt,
              onRefresh: () => setTick((value) => value + 1),
            }),
          )
        : error !== null
          ? h(ErrorState, { tr, detail: error, onRetry: () => setTick((value) => value + 1) })
          : h(LoadingState, { tr })

      return h(
        'div',
        {
          className: 'us-root',
          'data-days': String(days),
          'data-mode': mode,
          'data-loading': data === null && error === null ? '1' : '0',
        },
        h('style', null, CSS),
        h(UsageHeader, {
          tr,
          days,
          onDays: (value) => {
            if (value !== days) setDays(value)
          },
        }),
        h(
          'div',
          { className: 'us-intro' },
          h('div', { className: 'us-sub' }, tr('subtitle')),
          chips,
        ),
        body,
      )
    }

    // ---- plugin registration --------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The bundled dictionaries double as the registration payload, so the
        // page follows the active locale without re-detecting it.
        ctx.effect(
          () => ctx.locale.register(NS, { zh: TEXT.zh, en: TEXT.en }),
          'usage-stats: dictionaries',
        )
        const getLanguage = () => activeLanguage(ctx)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'usage',
              order: 2,
              label: () => (/^zh/i.test(getLanguage()) ? '用量' : 'Usage'),
              locale: NS,
              inject: () => ({ fetchReport, getLanguage }),
            },
            UsageSection,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'usage' }, UsageIcon),
        )
      },
      // Pure model surface for the no-browser tests; the module loader only
      // reads `inject` and `apply`, so this is inert at runtime.
      __model: {
        NS,
        ROUTE,
        RANGES,
        CATEGORIES,
        MODEL_SERIES_CAP,
        TEXT,
        parseReport,
        aggregateSeries,
        seriesLabel,
        seriesColor,
        cacheHitRatio,
        fmtTokens,
        fmtExact,
        fmtPct,
        fmtClock,
        formatDayLabel,
        niceMax,
        normBucket,
        textOf,
        isChinese,
        pageIsChinese,
        activeLanguage,
        UsageSection,
        UsageHeader,
        UsageIcon,
        UsageCards,
        UsageChart,
        ModelTable,
        Segmented,
      },
    }
  },
})