/**
 * MoA 只读工具支持（本地分支新增）
 *
 * 为什么需要：MoA 的候选模型与裁判模型原本只拿到静态上下文，无法搜索、读文件或
 * 执行命令，导致「评估测试」「分析这个 bug」这类任务拿不到实时信息。
 *
 * 设计原则（安全第一）：
 *  1. 只授予**只读**工具：ls / read / grep / glob / web_search / web_fetch
 *  2. bash 默认**不授予**，需显式 tools: { bash: true } 且限定只读命令白名单
 *  3. 每个候选最多 MAX_TOOL_ROUNDS 轮工具调用，防止死循环烧 token
 *  4. 工具执行错误作为内容回灌，不中断整条流水线
 *
 * 工具声明刻意用 pi-ai 的 JSON Schema 形态（type/properties/required），
 * 直接透传给 ctx.llm.prepareCall().stream({ tools })，避免依赖 schema DSL 编译器。
 */

export const MAX_TOOL_ROUNDS = 5

/** 允许的只读 shell 命令前缀（仅在 tools.bash 显式开启时生效）。 */
const READ_ONLY_COMMAND_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'tree',
  'pwd', 'whoami', 'date', 'uname', 'file', 'stat', 'du', 'df',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'node --version', 'pnpm --version', 'npm --version', 'python3 --version',
  'jq', 'echo',
]

/** 只读命令里绝不能出现的片段（重定向、写文件、管道到 shell、删除）。 */
const FORBIDDEN_FRAGMENTS = [
  '>', '>>', '|  sh', '| sh', '| bash', '|bash', '&& rm', '; rm', 'rm -',
  'mv ', ' cp ', 'chmod', 'chown', 'sudo', 'curl -X', '-X POST', '-X PUT', '-X DELETE',
  'tee ', 'dd ', 'mkfs', 'shutdown', 'reboot', 'kill ', 'pkill',
]

/**
 * 工具声明：pi-ai / OpenAI 兼容的 functions 形态。
 * 只有当对应能力存在时才下发（例如没有 webServer 就不给 web_search）。
 */
export const TOOL_DEFINITIONS = {
  read_file: {
    name: 'read_file',
    description: '读取工作区内某个文本文件的内容。path 为相对工作区根目录的路径。可选 offset/limit 按行读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的文件路径' },
        offset: { type: 'number', description: '起始行号（1 起）' },
        limit: { type: 'number', description: '最多读取的行数' },
      },
      required: ['path'],
    },
  },
  list_dir: {
    name: 'list_dir',
    description: '列出工作区内某个目录下的文件与子目录（不递归）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的目录路径，默认为 .' },
      },
    },
  },
  grep_files: {
    name: 'grep_files',
    description: '在工作区文件内容里做正则搜索，返回命中的文件、行号与内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索起点目录，默认 .' },
        glob: { type: 'string', description: '限定文件扩展名，例如 *.js' },
        maxResults: { type: 'number', description: '最多返回条数，默认 40' },
      },
      required: ['pattern'],
    },
  },
  find_files: {
    name: 'find_files',
    description: '按 glob 模式查找文件名，例如 **/*.ts。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式' },
        path: { type: 'string', description: '搜索起点目录，默认 .' },
      },
      required: ['pattern'],
    },
  },
  bash: {
    name: 'bash',
    description: '执行一条**只读** shell 命令（ls/cat/grep/find/git status 等）。写入类命令会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '只读命令' },
        description: { type: 'string', description: '命令用途的一句话说明' },
      },
      required: ['command'],
    },
  },
  web_search: {
    name: 'web_search',
    description: '联网搜索，返回若干条结果的标题、链接与摘要。用于获取实时信息。',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description: '1-4 条搜索词',
          items: { type: 'string' },
        },
      },
      required: ['queries'],
    },
  },
  web_fetch: {
    name: 'web_fetch',
    description: '抓取一个 http(s) URL 的正文并转成纯文本。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL' },
      },
      required: ['url'],
    },
  },
}

export const DEFAULT_READ_ONLY_TOOLS = ['read_file', 'list_dir', 'grep_files', 'find_files']

/**
 * 解析配置里的工具开关，返回真正要下发的工具定义数组。
 * @param toolsConfig preset.tools（true / 数组 / { bash:true, web:false } 等）
 * @param capabilities { web: boolean } 宿主能力探测结果
 */
export function resolveToolDefinitions(toolsConfig, capabilities = {}) {
  if (toolsConfig === false || toolsConfig === undefined || toolsConfig === null) return []
  const enabled = new Set()
  if (toolsConfig === true) {
    for (const name of DEFAULT_READ_ONLY_TOOLS) enabled.add(name)
    if (capabilities.web) { enabled.add('web_search'); enabled.add('web_fetch') }
    return [...enabled].map((name) => TOOL_DEFINITIONS[name]).filter(Boolean)
  }
  if (Array.isArray(toolsConfig)) {
    for (const name of toolsConfig) if (TOOL_DEFINITIONS[name]) enabled.add(name)
  } else if (typeof toolsConfig === 'object') {
    const { file = true, bash = false, web = true } = toolsConfig
    if (file) for (const name of DEFAULT_READ_ONLY_TOOLS) enabled.add(name)
    if (bash) enabled.add('bash')
    if (web && capabilities.web) { enabled.add('web_search'); enabled.add('web_fetch') }
  }
  return [...enabled].map((name) => TOOL_DEFINITIONS[name]).filter(Boolean)
}

/** 人类可读的工具清单，用于进度提示。 */
export function describeReadOnlyTools(defs) {
  return (defs || []).map((d) => d.name).join(', ')
}

/**
 * 工具入参归一化：模型可能给出 {queries:[...]} / {query:"x"} / {queries:"x"} 三种形态，
 * 也可能把整段 JSON 塞进 __raw。这里统一成标准形态。
 */
function normalizeArgs(raw, name) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return normalizeArgs(parsed, name)
    } catch { /* fallthrough */ }
    // 纯字符串直接作为主参数
    if (name === 'web_fetch') return { url: raw.trim() }
    if (name === 'grep_files') return { pattern: raw.trim() }
    return {}
  }
  if (typeof raw !== 'object') return {}
  const args = { ...raw }
  // __raw：解析失败的原文，尽量救回
  if (typeof args.__raw === 'string') {
    const salvaged = salvageFromRaw(args.__raw, name)
    return { ...salvaged, ...args, __raw: undefined }
  }
  return args
}

/** 从半截 JSON 文本里用正则抢救出字段。 */
function salvageFromRaw(raw, name) {
  const out = {}
  const urlMatch = raw.match(/https?:\/\/[^"'\\s]+/)
  if (urlMatch) out.url = urlMatch[0]
  const listMatch = raw.match(/"(?:queries|query)"\s*:\s*\[([^\]]*)/)
  if (listMatch) {
    const items = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (items.length > 0) { out.queries = items; out.query = items[0] }
  } else {
    const single = raw.match(/"(?:query|pattern|path|glob)"\s*:\s*"([^"]*)/)
    if (single) {
      if (raw.includes('"pattern"')) out.pattern = single[1]
      else if (raw.includes('"glob"')) out.glob = single[1]
      else if (raw.includes('"path"')) out.path = single[1]
      else if (raw.includes('"query"')) out.query = single[1]
    }
  }
  const cmdMatch = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (cmdMatch) out.command = cmdMatch[1].replace(/\\"/g, '"')
  return out
}

/** 从多种可能形态里取出搜索词列表。 */
function pickQueries(args = {}) {
  const candidates = [args.queries, args.query, args.q, args.terms, args.keywords]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()]
    if (Array.isArray(candidate)) {
      const list = candidate.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      if (list.length > 0) return list.slice(0, 4)
    }
  }
  // 兜底：从任意字符串值里找
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && /^\S/.test(value)) return [value.trim()]
  }
  return []
}

/** 从多种可能形态里取出 URL。 */
function pickUrl(args = {}) {
  const direct = args.url || args.uri || args.href || args.link || args.target
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim()
  }
  return ''
}

/** 把 web provider 的返回（sources/text/string）转成模型好读的纯文本。 */
function formatWebResult(res) {
  if (res === undefined || res === null) return '(空结果)'
  if (typeof res === 'string') return res
  if (Array.isArray(res)) return res.map(formatWebResult).join('\n\n')
  if (typeof res === 'object') {
    if (Array.isArray(res.sources) && res.sources.length > 0) {
      return res.sources.map((s, i) => {
        const title = s.title || s.name || s.heading || '(无标题)'
        const url = s.url || s.link || ''
        const snippet = s.snippet || s.text || s.content || ''
        return `[${i + 1}] ${title}\n${url}\n${String(snippet).slice(0, 600)}`
      }).join('\n\n')
    }
    if (typeof res.text === 'string' && res.text.trim()) return res.text
    if (typeof res.content === 'string' && res.content.trim()) return res.content
    if (typeof res.result === 'string') return res.result
    if (Array.isArray(res.result)) return res.result.map(formatWebResult).join('\n\n')
    if (res.error) return `搜索失败: ${typeof res.error === 'string' ? res.error : JSON.stringify(res.error)}`
    for (const key of ['data', 'results', 'items', 'answer']) {
      if (res[key] !== undefined) return formatWebResult(res[key])
    }
  }
  try { return JSON.stringify(res).slice(0, 8000) } catch { return String(res) }
}

function truncate(text, max = 6000) {
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  return str.length > max ? `${str.slice(0, max)}\n... [truncated ${str.length - max} chars]` : str
}

function assertSafeCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('空命令')
  if (/[;&]/.test(cmd.replace(/&&/g, ''))) throw new Error('只允许单条只读命令（禁止 ; & 串联）')
  for (const bad of FORBIDDEN_FRAGMENTS) {
    if (cmd.includes(bad)) throw new Error(`命令包含被禁止的片段: ${bad}`)
  }
  const normalized = cmd.replace(/\s+/g, ' ')
  if (!READ_ONLY_COMMAND_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p} `))) {
    throw new Error(`只读白名单不接受该命令：${normalized.slice(0, 60)}`)
  }
  return cmd
}

/**
 * 执行一次只读工具调用。
 * @param name 工具名
 * @param args 模型给出的参数
 * @param ctx { cwd, exec, web } 宿主能力
 */
export async function runReadOnlyToolCall(name, rawArgs = {}, ctx = {}) {
  const args = normalizeArgs(rawArgs, name)
  const cwd = ctx.cwd || process.cwd()
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const resolveInside = (p) => {
    const target = path.resolve(cwd, p || '.')
    const rel = path.relative(cwd, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越出工作区: ${p}`)
    return target
  }

  switch (name) {
    case 'read_file': {
      const target = resolveInside(args.path)
      const raw = await fs.readFile(target, 'utf8')
      const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 1
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 400
      const lines = raw.split('\n')
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return truncate(`共 ${lines.length} 行，显示 ${offset}-${offset + slice.length - 1}：\n` + slice.join('\n'))
    }
    case 'list_dir': {
      const target = resolveInside(args.path)
      const entries = await fs.readdir(target, { withFileTypes: true })
      const listing = entries
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')
      return truncate(`目录 ${path.relative(cwd, target) || '.'}：\n${listing}`)
    }
    case 'grep_files': {
      const pattern = String(args.pattern || args.query || args.q || '')
      if (!pattern) throw new Error(`pattern 不能为空，收到参数: ${JSON.stringify(rawArgs).slice(0, 200)}`)
      const re = new RegExp(pattern, 'i')
      const root = resolveInside(args.path)
      const ext = args.glob && args.glob.startsWith('*') ? args.glob.slice(1) : null
      const maxResults = Number.isFinite(args.maxResults) && args.maxResults > 0 ? Math.min(200, args.maxResults) : 40
      const hits = []
      const walk = async (dir) => {
        if (hits.length >= maxResults) return
        let entries = []
        try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (hits.length >= maxResults) return
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.moa') continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) { await walk(full); continue }
          if (ext && !entry.name.endsWith(ext)) continue
          let content = ''
          try { content = await fs.readFile(full, 'utf8') } catch { continue }
          if (content.length > 400000) continue
          content.split('\n').forEach((line, i) => {
            if (hits.length < maxResults && re.test(line)) {
              hits.push(`${path.relative(cwd, full)}:${i + 1}: ${line.trim().slice(0, 200)}`)
            }
          })
        }
      }
      await walk(root)
      return hits.length ? truncate(hits.join('\n')) : '无匹配'
    }
    case 'find_files': {
      const pattern = String(args.pattern || '')
      if (!pattern) throw new Error('pattern 不能为空')
      const root = resolveInside(args.path)
      const re = globToRegExp(pattern)
      const hits = []
      const walk = async (dir) => {
        if (hits.length >= 200) return
        let entries = []
        try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const full = path.join(dir, entry.name)
          const rel = path.relative(cwd, full)
          if (entry.isDirectory()) { await walk(full); continue }
          if (re.test(rel) || re.test(entry.name)) hits.push(rel)
        }
      }
      await walk(root)
      return hits.length ? truncate(hits.join('\n')) : '无匹配文件'
    }
    case 'bash': {
      const command = assertSafeCommand(args.command)
      if (typeof ctx.exec !== 'function') throw new Error('宿主未提供命令执行能力')
      const result = await ctx.exec(command, { workdir: cwd })
      return truncate(`$ ${command}\n${result || '(无输出)'}`)
    }
    case 'web_search': {
      if (!ctx.web?.search) throw new Error('宿主未提供联网搜索能力')
      const queries = pickQueries(args)
      if (queries.length === 0) throw new Error(`缺少搜索词，收到参数: ${JSON.stringify(rawArgs).slice(0, 200)}`)
      const res = await ctx.web.search({ queries: queries.slice(0, 4), maxResults: 5 })
      return truncate(formatWebResult(res), 12000)
    }
    case 'web_fetch': {
      if (!ctx.web?.fetch) throw new Error('宿主未提供网页抓取能力')
      const url = pickUrl(args)
      if (!/^https?:\/\//i.test(url)) throw new Error(`只支持 http(s) URL，收到参数: ${JSON.stringify(rawArgs).slice(0, 200)}`)
      const res = await ctx.web.fetch({ url })
      return truncate(formatWebResult(res), 12000)
    }
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
