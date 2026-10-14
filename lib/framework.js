/**
 * 框架核心：识别「测试工作框架」根、扫描状态、读写产品级登记、脚手架、模块登记。
 *
 * 设计红线：
 *   · **零第三方依赖**（只用 node: 内置模块）—— 插件可能是 `link:` 安装的，真实路径在
 *     profile 之外，解析不到 profile 的 node_modules；任何依赖都会让插件在别人的机器上装不起来。
 *   · **不覆盖已有内容**。模块 `SKILL.md`、框架 `AGENTS.md` 都是**累积型文档**，
 *     脚手架与登记一律「已存在即跳过 / 只追加行」，要覆盖必须显式 `force: true`。
 *   · **失败要看得见**：所有返回都带 `warnings`，不吞异常。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderTemplateSafe, templateExists, readTemplate, listTemplateFiles, TEMPLATE_ROOT } from './templates.js'
import { checkPrerequisites, renderPrereqBlock } from './prereq.js'
import { checkIsolation, renderIsolationBlock } from './isolation.js'

/** 机器可读登记文件的 schema 标识。改结构必须改这里。 */
export const REGISTRY_SCHEMA = 'dsh-test-framework/product/v1'
/** 产品级规范目录名（`_` 开头 = 辅助目录，不是模块）。 */
export const CONFIG_DIR = '_框架配置'
/** 机器可读登记文件名。 */
export const REGISTRY_FILE = '框架登记.json'
/** 框架根标记文件（插件自己认的，比只认 .git 更稳）。 */
export const ROOT_MARKER = '.dsh-test-framework.json'

/**
 * 需求文档总根目录 —— 运行时解析，**不写死**。
 *
 * 优先级（高 → 低）：
 *   ① 显式参数（工具调用里的 `reqDocRoot`）；
 *   ② 插件配置 `config.reqDocRoot`（profile 的 `cordis.patch.yml` 里给，见 `setReqDocRoot`）；
 *   ③ 环境变量 `DSH_REQ_DOC_ROOT`；
 *   ④ 兜底 `<用户主目录>\需求业务文档`。
 *
 * 为什么不写死一个绝对路径：这个包是要发出去给别人用的，
 * 写死作者自己的盘符会让每个装它的人生成一堆指向**别人机器**的路径。
 */
export function defaultReqDocRoot() {
  if (typeof configuredReqDocRoot === 'string' && configuredReqDocRoot.trim() !== '') {
    return configuredReqDocRoot.trim()
  }
  const fromEnv = process.env.DSH_REQ_DOC_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '需求业务文档')
}

/** 由宿主入口从 `config.reqDocRoot` 注入（`apply(ctx, config)` 里调）。 */
let configuredReqDocRoot = ''
export function setReqDocRoot(value) {
  configuredReqDocRoot = typeof value === 'string' ? value : ''
}

/**
 * 往 JSON 模板里填值时转义。
 *
 * 为什么必须做：模板里写的是 `"frameworkRoot": "{{FRAMEWORK_ROOT}}"`，
 * 而 Windows 路径形如 `D:\MyFramework` —— 直接替换会得到 `"D:\MyFramework"`，
 * 其中 `\A` **不是合法 JSON 转义**，整个文件解析失败。所以 JSON 目标要把值先转义一遍。
 */
function escapeForJson(value) {
  return JSON.stringify(String(value)).slice(1, -1)
}

/** 判断一个目录是不是「模块」时，永远排除这些名字。 */
const NON_MODULE_DIRS = new Set([
  CONFIG_DIR,
  '_冒泡测试',
  '_库结构',
  '_report',
  '_data',
  '_archive',
  '_templates',
  '_plugin',
])

/** 产品根下这些名字是辅助目录，不是产品。 */
const NON_PRODUCT_DIRS = new Set([
  'skills',
  'node_modules',
  '_templates',
  '_archive',
  '_plugin',
  '.git',
  '.dsh',
  '.svn',
])

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 存在性判断（同步，绝不抛）。 */
export function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/** 是不是目录（同步，绝不抛；跟随符号链接）。 */
export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 是不是普通文件。 */
export function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 读文本（失败返回 undefined）。 */
export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/** 目录项（失败返回 []）。 */
export function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
  } catch {
    return []
  }
}

/** `yyyy-MM-dd`（本地时区）。 */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `yyyyMMdd`。 */
export function stamp(now = new Date()) {
  return today(now).replace(/-/g, '')
}

/** ISO 时间戳。 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * 写文件；父目录自动创建。
 * `ifAbsent: true` 时文件已存在则跳过（返回 `{ written: false, reason: 'exists' }`）。
 */
export function writeFileSyncSafe(file, content, { ifAbsent = false } = {}) {
  if (ifAbsent && exists(file)) return { written: false, reason: 'exists', path: file }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { written: true, path: file }
}

/** 建目录（幂等）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 框架根识别
// ---------------------------------------------------------------------------

/**
 * 一个目录够不够格当「框架根」。
 *
 * 三级判据（任一命中即可，从严到宽）：
 *   ① 有插件写的标记文件 `.dsh-test-framework.json`；
 *   ② 有 `AGENTS.md` 且有 `_templates\` 或 `skills\`（框架自己的形态）；
 *   ③ 有 `AGENTS.md` 且有 `_框架配置` 或任一产品目录（宽容形态）。
 *
 * 为什么不只认 `.git`：DSH 的 `findProjectRoot` 只认 `.git`，用户框架里的 `.git` 就是
 * 为了这个而建的空库；但**初始化前**的工作区还没有 `.git`，插件必须能先把它认出来。
 */
export function isFrameworkRoot(dir) {
  if (!isDir(dir)) return false
  if (isFile(path.join(dir, ROOT_MARKER))) return true
  if (!isFile(path.join(dir, 'AGENTS.md'))) return false
  if (isDir(path.join(dir, '_templates')) || isDir(path.join(dir, 'skills'))) return true
  if (isDir(path.join(dir, CONFIG_DIR)) || listProducts(dir).length > 0) return true
  return false
}

/**
 * 从 `start`（默认 cwd）向上找框架根。
 * @returns {{ root: string, via: string, searched: string[] } | undefined}
 */
export function findFrameworkRoot(start = process.cwd()) {
  const searched = []
  let dir = path.resolve(start)
  for (;;) {
    searched.push(dir)
    if (isFrameworkRoot(dir)) {
      let via = 'AGENTS.md+_templates/skills'
      if (isFile(path.join(dir, ROOT_MARKER))) via = ROOT_MARKER
      return { root: dir, via, searched }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 找 DSH 眼里的「项目根」（含 `.git` 的最近祖先）—— 用来判断框架约束会不会被自动加载。 */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start)
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// 产品 / 模块枚举
// ---------------------------------------------------------------------------

/** 一个目录像不像「模块」：非 `_` 开头，且（有 SKILL.md 或 有 requirement/final/report/data 之一）。 */
export function looksLikeModule(dir) {
  const base = path.basename(dir)
  if (base.startsWith('_') || base.startsWith('.')) return false
  if (NON_MODULE_DIRS.has(base)) return false
  if (!isDir(dir)) return false
  if (isFile(path.join(dir, 'SKILL.md'))) return true
  return ['requirement', 'final', 'report', 'data', 'scripts'].some((sub) => isDir(path.join(dir, sub)))
}

/** 产品的模块清单。 */
export function listModules(productDir) {
  return listDir(productDir)
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && looksLikeModule(path.join(productDir, e.name)))
    .map((e) => e.name)
    .sort()
}

/** 一个目录像不像「产品」：非辅助名，且（有 `_框架配置` / `_冒泡测试` / `_库结构` 或 ≥1 个模块）。 */
export function looksLikeProduct(dir) {
  const base = path.basename(dir)
  if (base.startsWith('_') || base.startsWith('.')) return false
  if (NON_PRODUCT_DIRS.has(base)) return false
  if (!isDir(dir)) return false
  if ([CONFIG_DIR, '_冒泡测试', '_库结构'].some((sub) => isDir(path.join(dir, sub)))) return true
  return listModules(dir).length > 0
}

/** 框架根下的产品清单。 */
export function listProducts(root) {
  return listDir(root)
    .filter((e) => e.isDirectory() && looksLikeProduct(path.join(root, e.name)))
    .map((e) => e.name)
    .sort()
}

/** 产品目录的绝对路径。 */
export function productDirOf(root, product) {
  return path.join(root, product)
}

/** 产品级规范目录。 */
export function configDirOf(root, product) {
  return path.join(root, product, CONFIG_DIR)
}

// ---------------------------------------------------------------------------
// 框架登记（机器可读）
// ---------------------------------------------------------------------------

/** 一份空登记。 */
export function emptyRegistry({ product, frameworkRoot, pluginVersion = 'unknown' }) {
  return {
    schema: REGISTRY_SCHEMA,
    product,
    frameworkRoot,
    createdBy: 'dsh-test-framework 插件自动生成',
    pluginVersion,
    updatedAt: today(),
    documents: [],
    environments: [],
    modules: [],
    gates: {
      documentsRegistered: false,
      versionsConfirmed: false,
      crossDocChecked: false,
      splitConfirmed: false,
      environmentRegistered: false,
    },
  }
}

/** 读登记（不存在或损坏返回 undefined，损坏原因放 `warnings`）。 */
export function readRegistry(root, product) {
  const file = path.join(configDirOf(root, product), REGISTRY_FILE)
  if (!isFile(file)) return { file, registry: undefined, warnings: [] }
  const raw = readText(file)
  if (raw === undefined) return { file, registry: undefined, warnings: [`读不到 ${file}`] }
  try {
    const registry = JSON.parse(raw)
    return { file, registry, warnings: [] }
  } catch (error) {
    return { file, registry: undefined, warnings: [`${REGISTRY_FILE} 不是合法 JSON：${error.message}`] }
  }
}

/** 写登记（先写临时文件再改名，避免半截文件）。 */
export function writeRegistry(root, product, registry) {
  const dir = ensureDir(configDirOf(root, product))
  const file = path.join(dir, REGISTRY_FILE)
  const next = { ...registry, schema: REGISTRY_SCHEMA, product, frameworkRoot: root, updatedAt: today() }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return { file, registry: next }
}

/** 确保登记存在（没有就建一份空的）。 */
export function ensureRegistry(root, product, { pluginVersion = 'unknown' } = {}) {
  const { file, registry, warnings } = readRegistry(root, product)
  if (registry) return { file, registry, created: false, warnings }
  const fresh = emptyRegistry({ product, frameworkRoot: root, pluginVersion })
  const written = writeRegistry(root, product, fresh)
  return { file: written.file, registry: written.registry, created: true, warnings }
}

/**
 * 按登记内容**重算** gates（不信任手工填的值 —— 这是闸门能不能拦住人的关键）。
 *
 * 注意「跨文档关联」用 `hasOwnProperty` 判：用户答「没有」要写成 `relatedDocs: []`（= 问过了），
 * 缺这个 key 才等于「没问」。两者不能混。
 */
export function recomputeGates(registry) {
  const docs = Array.isArray(registry.documents) ? registry.documents : []
  const envs = Array.isArray(registry.environments) ? registry.environments : []
  const mods = Array.isArray(registry.modules) ? registry.modules : []
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '' && v !== '（待补）'
  return {
    documentsRegistered: docs.length > 0,
    versionsConfirmed: docs.length > 0 && docs.every((d) => nonEmpty(d?.version)),
    crossDocChecked: docs.length > 0 && docs.every((d) => Object.hasOwn(d ?? {}, 'relatedDocs')),
    splitConfirmed:
      docs.length > 0 && docs.every((d) => Array.isArray(d?.split) && d.split.length > 0 && d?.splitConfirmed !== false),
    environmentRegistered: envs.length > 0,
    modulesRegistered: mods.length > 0,
  }
}

/** 缺哪些、缺了怎么办 —— 直接可渲染成给用户看的提问清单。 */
export function missingItems(registry) {
  const gates = recomputeGates(registry)
  const docs = Array.isArray(registry.documents) ? registry.documents : []
  const out = []
  if (!gates.documentsRegistered) {
    out.push({
      key: 'documentsRegistered',
      ask: '本次要测的是哪一份需求文档？（给文件名或关键词即可，我来定位；**不要凭记忆猜路径**）',
    })
  }
  if (gates.documentsRegistered && !gates.splitConfirmed) {
    const bad = docs.filter((d) => !Array.isArray(d?.split) || d.split.length === 0)
    out.push({
      key: 'splitConfirmed',
      ask: `这些需求文档还没确认「拆成哪几个模块」：${bad.map((d) => d.name).join('、')}。`
        + '请确认拆分方案（页数 >100 页、或一份文档里含多个子模块时**必须拆**）。',
    })
  }
  if (gates.documentsRegistered && !gates.crossDocChecked) {
    const bad = docs.filter((d) => !Object.hasOwn(d ?? {}, 'relatedDocs'))
    out.push({
      key: 'crossDocChecked',
      ask: `这几份文档还没确认「本地有没有别的需求文档与它关联」：${bad.map((d) => d.name).join('、')}。`
        + '（有些业务逻辑写在另一份需求文档里；没有请明确回答「没有」。）',
    })
  }
  if (gates.documentsRegistered && !gates.versionsConfirmed) {
    const bad = docs.filter((d) => !(typeof d?.version === 'string' && d.version.trim()))
    out.push({
      key: 'versionsConfirmed',
      ask: `这几份文档还没确认「本次测的是哪一版」：${bad.map((d) => d.name).join('、')}。`
        + '（需求文档路径不区分版本，版本判错后面全白干。）',
    })
  }
  if (!gates.environmentRegistered) {
    out.push({
      key: 'environmentRegistered',
      ask: '请给测试环境信息：① 页面地址与账号密码；② 数据库地址/端口/库名/schema/用户名/密码（可写库吗）；'
        + '③ 造数用的数据地址。**不给就不开测**。',
    })
  }
  if (!gates.modulesRegistered) {
    out.push({ key: 'modulesRegistered', ask: '确认拆分后，我把每个子模块的目录与 SKILL.md 建好并登记到 AGENTS.md §三。' })
  }
  return out
}

// ---------------------------------------------------------------------------
// markdown 表格操作
// ---------------------------------------------------------------------------

const DELIMITER_ROW = /^\s*\|[\s:|-]+\|\s*$/

/**
 * 在一张表里 upsert 一行。
 *
 * 定位方式：找**表头同时包含 `signature` 全部词**的第一张表，然后
 *   · 若表里已有同 `keyIndex` 列值相同的行 → 就地替换（保证幂等，反复登记不会堆行）；
 *   · 否则插到该表最后一行之后。
 * 找不到表 → 返回 `{ ok: false }`，调用方自己决定追加到哪儿（**不许静默丢数据**）。
 *
 * @param {string} md markdown 正文
 * @param {string[]} signature 表头必须包含的词
 * @param {number} keyIndex 用来判重/替换的列序号（0-based）
 * @param {string[]} cells 新行的各列（不要带两端的 `|`）
 */
export function upsertTableRow(md, signature, keyIndex, cells) {
  const lines = String(md ?? '').split(/\r?\n/)
  const key = String(cells[keyIndex] ?? '').trim()
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i]
    if (!header.trim().startsWith('|')) continue
    if (!signature.every((term) => header.includes(term))) continue
    if (!DELIMITER_ROW.test(lines[i + 1] ?? '')) continue
    const headerCells = splitRow(header)
    // 找表尾
    let end = i + 2
    while (end < lines.length && lines[end].trim().startsWith('|')) end += 1
    const rowText = `| ${cells.map((c) => String(c ?? '').trim()).join(' | ')} |`
    for (let j = i + 2; j < end; j += 1) {
      const rowCells = splitRow(lines[j])
      if (String(rowCells[keyIndex] ?? '').trim() === key) {
        lines[j] = rowText
        return { ok: true, md: lines.join('\n'), action: 'replace', row: j, headerCells, tableStart: i }
      }
      // 模板里的占位行：第一次真实登记就把它顶掉
      if (PLACEHOLDER_CELLS.has(String(rowCells[0] ?? '').trim()) && j === i + 2) {
        lines[j] = rowText
        return { ok: true, md: lines.join('\n'), action: 'replace-placeholder', row: j, headerCells, tableStart: i }
      }
    }
    lines.splice(end, 0, rowText)
    return { ok: true, md: lines.join('\n'), action: 'append', row: end, headerCells, tableStart: i }
  }
  return { ok: false, md: String(md ?? ''), action: 'no-table' }
}

const PLACEHOLDER_CELLS = new Set(['（待登记）', '(待登记)', '（待补）', '(待补)', '（待录入）', '-', ''])

/** 拆 `| a | b |` → `['a','b']`。 */
export function splitRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

/**
 * 往 markdown 末尾追加一节（表格定位失败时的**兜底**，绝不丢数据）。
 */
export function appendSection(md, title, body) {
  const base = String(md ?? '').replace(/\s+$/, '')
  return `${base}\n\n---\n\n## ${title}\n\n${body}\n`
}

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/**
 * 初始化框架骨架。
 *
 * @param {object} options
 * @param {string} options.root 目标框架根（默认 cwd）
 * @param {string} options.product 产品名（如「示例产品」）
 * @param {string} [options.reqDocRoot] 需求文档总根目录
 * @param {string} [options.module] 顺便建一个模块（可空）
 * @param {string} [options.menu] 该模块对应的顶级菜单
 * @param {string} [options.route] 该模块页面路由
 * @param {string} [options.slug] 该模块的 kebab-case slug
 * @param {boolean} [options.force] 覆盖已存在的**模板文件**（默认 false；模块 SKILL.md 永不覆盖）
 * @param {boolean} [options.dryRun] 只出计划不落盘
 * @param {string} [options.pluginVersion]
 * @param {string} [options.git] `'auto' | 'init' | 'skip'`
 */
export function scaffold(options) {
  const root = path.resolve(options.root ?? process.cwd())
  const product = String(options.product ?? '').trim()
  if (!product) throw new Error('scaffold 需要 product（产品名）')
  const productDir = path.join(root, product)
  const reqDocRoot = options.reqDocRoot ?? defaultReqDocRoot()
  const force = options.force === true
  const dryRun = options.dryRun === true
  const pluginVersion = options.pluginVersion ?? 'unknown'
  const vars = {
    PRODUCT: product,
    PRODUCT_DIR: product,
    FRAMEWORK_ROOT: root,
    REQ_DOC_ROOT: reqDocRoot,
    DATE: today(),
    PLUGIN_VERSION: pluginVersion,
    GENERATED_BY: 'dsh-test-framework 插件自动生成',
  }
  const plan = { created: [], skipped: [], warnings: [], plan: [] }

  /** 本次运行里由 `put` 真正写下去的文件（用来区分「我这次建的」和「本来就有的」）。 */
  const wroteNow = new Set()

  const put = (rel, content) => {
    const abs = path.join(root, rel)
    if (exists(abs) && !force) {
      plan.skipped.push(rel)
      return
    }
    plan.plan.push(`写文件 ${rel}`)
    if (dryRun) return
    writeFileSyncSafe(abs, content)
    plan.created.push(rel)
    wroteNow.add(rel)
  }

  const mkdir = (rel) => {
    plan.plan.push(`建目录 ${rel}`)
    if (!dryRun) ensureDir(path.join(root, rel))
  }

  /** 与 `put` 同语义，但内容**原样落盘不渲染**（用于 .py 这类含 `%s` / `{}` 的文件）。 */
  const putRaw = (rel, content) => {
    const abs = path.join(root, rel)
    if (exists(abs) && !force) {
      plan.skipped.push(rel)
      return
    }
    plan.plan.push(`写文件 ${rel}（原样，不渲染）`)
    if (dryRun) return
    writeFileSyncSafe(abs, content)
    plan.created.push(rel)
    wroteNow.add(rel)
  }

  // ---- 1. 框架根文件 ----
  for (const rel of ['AGENTS.md', 'README.md']) {
    if (!templateExists(rel)) {
      plan.warnings.push(`模板缺失：templates/${rel}（跳过）`)
      continue
    }
    put(rel, renderTemplateSafe(rel, vars))
  }

  // ---- 2. _templates：整棵「模块骨架」树都拷（含 skill\版本骨架）+ 测试报告模板 ----
  mkdir('_templates')
  const tplFiles = [
    ...listTemplateFiles('模块骨架').map((rel) => path.join('模块骨架', rel)),
    '测试报告模板.md',
  ]
  for (const rel of tplFiles) {
    if (!templateExists(rel)) {
      plan.warnings.push(`模板缺失：templates/${rel}（跳过）`)
      continue
    }
    put(path.join('_templates', rel), renderTemplateSafe(rel, vars))
  }

  // ---- 3. 框架级 skill ----
  for (const rel of listTemplateFiles('skills')) {
    if (!rel.endsWith('SKILL.md')) continue
    put(path.join('skills', rel), renderTemplateSafe(path.join('skills', rel), vars))
  }

  // ---- 4. 归档区 ----
  mkdir('_archive')
  for (const sub of ['scripts', 'backups', 'outputs', '报告归档']) mkdir(path.join('_archive', sub))

  // ---- 5. 产品级规范 ----
  mkdir(product)
  mkdir(path.join(product, CONFIG_DIR))
  mkdir(path.join(product, '_冒泡测试'))
  mkdir(path.join(product, '_库结构'))

  // 报告回收脚本：`<产品>\_冒泡测试\archive_reports.py`（满 24h 的报告移到 _archive\报告归档\）。
  // 原样落盘不走渲染 —— Python 里的 `%s` / `{}` 不能拿去当模板变量。
  for (const rel of listTemplateFiles(path.join('产品', '_冒泡测试'))) {
    const tplRel = path.join('产品', '_冒泡测试', rel)
    if (!templateExists(tplRel)) continue
    putRaw(path.join(product, '_冒泡测试', rel), readTemplate(tplRel))
  }

  for (const rel of listTemplateFiles(path.join('产品', CONFIG_DIR))) {
    const tplRel = path.join('产品', CONFIG_DIR, rel)
    if (!templateExists(tplRel)) continue
    const target = path.join(product, CONFIG_DIR, rel)
    // JSON 模板里的 Windows 路径必须先转义，否则渲染出 `"D:\MyFramework"` 这种非法 JSON
    const isJson = rel.toLowerCase().endsWith('.json')
    const renderVars = isJson
      ? Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeForJson(v)]))
      : vars
    put(target, renderTemplateSafe(tplRel, renderVars))
  }

  // ---- 6. 登记文件：**机器可读的那份最终由代码生成**，保证一定是合法 JSON ----
  if (!dryRun) {
    const regRel = path.join(product, CONFIG_DIR, REGISTRY_FILE)
    // 上面模板循环可能已经写了同名文件（那份是渲染出来的，路径转义对但内容不是权威），
    // 这里统一以**代码生成的那份**为准，并把它算作「本次新建」而不是「跳过」。
    const freshFromTemplate = wroteNow.has(regRel)
    plan.created = plan.created.filter((p) => p !== regRel)
    plan.skipped = plan.skipped.filter((p) => p !== regRel)
    const existing = freshFromTemplate ? { registry: undefined, warnings: [] } : readRegistry(root, product)
    if (existing.registry) {
      plan.skipped.push(regRel)
    } else {
      if (!freshFromTemplate && existing.file && isFile(existing.file)) {
        plan.warnings.push(
          `${REGISTRY_FILE} 存在但不是合法 JSON（${existing.warnings.join('；')}）—— 已用代码生成的空登记覆盖（原文未备份，如需要请从版本库找回）`,
        )
      }
      const fresh = emptyRegistry({ product, frameworkRoot: root, pluginVersion })
      writeRegistry(root, product, fresh)
      plan.created.push(regRel)
    }
  }

  // ---- 7. 可选：顺手建一个模块 ----
  if (options.module) {
    const added = addModule({
      root,
      product,
      module: options.module,
      menu: options.menu,
      route: options.route,
      slug: options.slug,
      pluginVersion,
      dryRun,
    })
    plan.created.push(...added.created)
    plan.skipped.push(...added.skipped)
    plan.warnings.push(...added.warnings)
  }

  // ---- 8. 目录联接 .dsh\skills → ..\skills（DSH 的 skill 发现入口） ----
  const linkPath = path.join(root, '.dsh', 'skills')
  if (exists(linkPath)) {
    plan.skipped.push('.dsh\\skills')
  } else {
    plan.plan.push('建目录联接 .dsh\\skills → ..\\skills')
    if (!dryRun) {
      ensureDir(path.join(root, '.dsh'))
      try {
        fs.symlinkSync(path.join('..', 'skills'), linkPath, 'junction')
        plan.created.push('.dsh\\skills')
      } catch (error) {
        plan.warnings.push(`建 .dsh\\skills 联接失败（${error.message}）—— `
          + `DSH 会因此发现不到框架级 skill；请手工执行：`
          + `New-Item -ItemType Junction -Path "${linkPath}" -Target "${path.join(root, 'skills')}"`)
      }
    }
  }

  // ---- 9. 项目根标记 .git（DSH 的 findProjectRoot 只认它） ----
  const gitPath = path.join(root, '.git')
  if (exists(gitPath)) {
    plan.skipped.push('.git')
  } else if (options.git === 'skip') {
    plan.warnings.push('按参数跳过 .git —— DSH 在子目录里开会话时，框架级 skill 会静默不加载')
  } else {
    plan.plan.push('建 .git（项目根标记）')
    if (!dryRun) {
      const ok = initGit(root)
      if (ok) plan.created.push('.git')
      else {
        try {
          ensureDir(gitPath)
          fs.writeFileSync(path.join(gitPath, 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
          fs.writeFileSync(path.join(gitPath, 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')
          plan.created.push('.git')
          plan.warnings.push('本机没有可用的 git，已建一个最小 .git 目录当根标记（够 DSH 用，但不是真仓库）')
        } catch (error) {
          plan.warnings.push(`建 .git 失败（${error.message}）—— 子目录开会话时框架级 skill 会不加载`)
        }
      }
    }
  }

  // ---- 10. 插件自己的根标记 ----
  put(ROOT_MARKER, `${JSON.stringify(
    {
      schema: 'dsh-test-framework/root/v1',
      product,
      frameworkRoot: root,
      initializedAt: nowIso(),
      pluginVersion,
      note: '本文件由 dsh-test-framework 插件写入，仅用于标识「这里是测试框架根」，勿删。',
    },
    null,
    2,
  )}\n`)

  return plan
}

/** 跑 `git init`；本机没有 git 就返回 false（不抛）。 */
function initGit(cwd) {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (probe.status !== 0) return false
    const run = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true })
    return run.status === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 模块登记
// ---------------------------------------------------------------------------

/** 把任意名字压成 kebab-case slug（只保留 ASCII 字母数字）。 */
export function slugify(name) {
  const ascii = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii
}

/**
 * 新增一个模块：建目录 → 生成 `SKILL.md`（按模块骨架模板渲染）→ 回填两处路由表 → 更新登记。
 *
 * **模块 `SKILL.md` 已存在时永不覆盖**（它是累积型文档，见框架铁律）。
 */
export function addModule(options) {
  const root = path.resolve(options.root ?? process.cwd())
  const product = String(options.product ?? '').trim()
  const module = String(options.module ?? '').trim()
  if (!product) throw new Error('addModule 需要 product')
  if (!module) throw new Error('addModule 需要 module')
  const dryRun = options.dryRun === true
  const pluginVersion = options.pluginVersion ?? 'unknown'
  const menu = options.menu ?? '（待补）'
  const menuPath = options.menuPath ?? menu
  const route = options.route ?? '（待补）'
  const doc = options.doc ?? ''
  const version = options.version ?? ''
  const slugInput = String(options.slug ?? '').trim() || slugify(module)
  const slug = slugInput || `mod-${Math.abs(hash32(module)).toString(36)}`
  const result = { created: [], skipped: [], warnings: [], slug, skillPath: undefined, versionSkillPath: undefined }

  if (!slugInput) {
    result.warnings.push(
      `模块名「${module}」是纯中文，自动兜底的 slug 是 \`${slug}\`（不好看也不好记）。`
      + '建议重跑并显式传 slug（拼音，如 缺药登记 → queyao-dengji）。',
    )
  }

  const productDir = path.join(root, product)
  const moduleDir = path.join(productDir, module)
  // `skill\` 是「按版本区分规范」的落点：`skill\<版本>\SKILL.md`，一版一份，互不覆盖。
  const subs = ['requirement', 'final', 'report', 'data', 'skill']
  if (!dryRun) {
    ensureDir(moduleDir)
    for (const sub of subs) ensureDir(path.join(moduleDir, sub))
  }
  result.created.push(...subs.map((s) => path.join(product, module, s)))

  // ---- SKILL.md（模块索引） ----
  const skillRel = path.join(product, module, 'SKILL.md')
  const skillAbs = path.join(root, skillRel)
  result.skillPath = skillAbs
  if (exists(skillAbs)) {
    result.skipped.push(skillRel)
    result.warnings.push(
      `${skillRel} 已存在 —— **没有覆盖**（模块 SKILL.md 是累积型文档）。`
      + '要补内容请手工往它上面追加，或先备份再显式 `force`。',
    )
  } else {
    const tplRel = path.join('模块骨架', 'SKILL.md')
    if (!templateExists(tplRel)) {
      result.warnings.push(`模板缺失：templates/${tplRel} —— 模块 SKILL.md 没生成`)
    } else {
      const text = renderTemplateSafe(tplRel, {
        PRODUCT: product,
        PRODUCT_DIR: product,
        FRAMEWORK_ROOT: root,
        REQ_DOC_ROOT: options.reqDocRoot ?? defaultReqDocRoot(),
        MODULE: module,
        MODULE_SLUG: slug,
        MENU: menu,
        MENU_PATH: menuPath,
        ROUTE: route,
        DATE: today(),
        PLUGIN_VERSION: pluginVersion,
        GENERATED_BY: 'dsh-test-framework 插件自动生成',
      })
      if (!dryRun) {
        writeFileSyncSafe(skillAbs, text)
        result.created.push(skillRel)
      }
    }
  }

  // ---- skill\<版本>\SKILL.md（按版本区分的规范；没给版本就不建） ----
  if (version) {
    const verRel = path.join(product, module, 'skill', version, 'SKILL.md')
    const verAbs = path.join(root, verRel)
    result.versionSkillPath = verAbs
    if (exists(verAbs)) {
      result.skipped.push(verRel)
    } else {
      const tplRel = path.join('模块骨架', 'skill', '版本骨架', 'SKILL.md')
      if (!templateExists(tplRel)) {
        result.warnings.push(`模板缺失：templates/${tplRel} —— ${version} 版本规范没生成`)
      } else {
        const text = renderTemplateSafe(tplRel, {
          PRODUCT: product,
          PRODUCT_DIR: product,
          FRAMEWORK_ROOT: root,
          REQ_DOC_ROOT: options.reqDocRoot ?? defaultReqDocRoot(),
          MODULE: module,
          MODULE_SLUG: slug,
          MENU: menu,
          MENU_PATH: menuPath,
          ROUTE: route,
          VERSION: version,
          DATE: today(),
          PLUGIN_VERSION: pluginVersion,
          GENERATED_BY: 'dsh-test-framework 插件自动生成',
        })
        if (!dryRun) {
          ensureDir(path.dirname(verAbs))
          writeFileSyncSafe(verAbs, text)
          result.created.push(verRel)
        }
      }
    }
  } else {
    result.warnings.push(
      '没给 version —— **没有建版本规范** `skill\\<版本>\\SKILL.md`。'
      + '按框架约定，模块规范要按版本分开（一版一份），建议带上 version 重跑。',
    )
  }

  // ---- 回填模块索引 §8 版本索引 + §1 当前在测版本 ----
  // 用户要求「一个模块下面区分多个版本」：**索引必须真能列出各版本**。
  // 只建 `skill\<版本>\` 而不登记，等于把版本规范藏起来 —— 下一版就没有入口。
  if (version) {
    const indexMd = readText(skillAbs)
    if (indexMd === undefined) {
      // dryRun 时索引文件还没落盘：只报计划，不算异常
      if (dryRun) result.created.push(`${skillRel} §8 版本索引（计划：${version}）`)
      else result.warnings.push(`${skillRel} 读不到 —— §8 版本索引没回填，请手工加一行`)
    } else {
      let md = indexMd
      const verRow = [
        version,
        `\`skill\\${version}\\SKILL.md\``,
        `\`final\\${version}-${module}造数逻辑.md\``,
        '（待补）',
        '（待补）',
        '（待补）',
      ]
      const mergedVer = upsertTableRow(md, ['版本', '版本规范'], 0, verRow)
      if (!mergedVer.ok) {
        result.warnings.push(`${skillRel} 里没找到「版本 | 版本规范」表 —— §8 版本索引没回填，请手工加一行`)
      } else {
        md = mergedVer.md
        if (mergedVer.md !== indexMd) result.created.push(`${skillRel} §8 版本索引（${version}）`)
        else result.skipped.push(`${skillRel} §8 版本索引（已存在 ${version}）`)
      }
      // §1「当前在测版本」——本次这一版就是"当前"
      const curRow = ['当前在测版本', `${version} —— 必须与 \`_框架配置\\框架登记.json\` 里登记的版本一致`]
      const mergedCur = upsertTableRow(md, ['项', '内容'], 0, curRow)
      if (!mergedCur.ok) {
        result.warnings.push(`${skillRel} 里没找到「项 | 内容」表 —— §1 当前在测版本没回填`)
      } else if (mergedCur.md !== md) {
        md = mergedCur.md
        result.created.push(`${skillRel} §1 当前在测版本（${version}）`)
      }
      if (!dryRun && md !== indexMd) fs.writeFileSync(skillAbs, md, 'utf8')
    }
  }

  // ---- 回填框架根 AGENTS.md §三 ----
  const agentsRel = 'AGENTS.md'
  const agentsAbs = path.join(root, agentsRel)
  const agentsMd = readText(agentsAbs)
  if (agentsMd === undefined) {
    result.warnings.push('框架根没有 AGENTS.md —— 模块登记没法回填，请先跑脚手架')
  } else {
    const verNote = version ? `（**${version}** 版规范：\`${product}\\${module}\\skill\\${version}\\SKILL.md\`）` : ''
    const row = [module, `见 ${product}\\${module}\\SKILL.md（索引）${verNote}`, doc ? `\`${doc}\`` : '（待补）']
    const merged = upsertTableRow(agentsMd, ['模块', '定位'], 0, row)
    if (merged.ok) {
      if (!dryRun && merged.md !== agentsMd) fs.writeFileSync(agentsAbs, merged.md, 'utf8')
      if (merged.md !== agentsMd) result.created.push('AGENTS.md §三（模块路由）')
      else result.skipped.push('AGENTS.md §三（已存在该模块行）')
    } else {
      result.warnings.push('AGENTS.md 里没找到「模块 | 定位」表 —— 模块没登记进去，请手工补 §三')
    }
  }

  // ---- 回填产品级 模块路由.md ----
  const routeRel = path.join(product, CONFIG_DIR, '模块路由.md')
  const routeAbs = path.join(root, routeRel)
  const routeMd = readText(routeAbs)
  if (routeMd === undefined) {
    result.warnings.push(`${routeRel} 不存在 —— 请先跑脚手架（或手工补这张表）`)
  } else {
    const skillLink = version
      ? `[索引](../${module}/SKILL.md) ｜ [${version}](../${module}/skill/${version}/SKILL.md)`
      : `[索引](../${module}/SKILL.md)`
    const row = [
      module, '（待补）', menu, menuPath, route, '（待补）',
      version || '（待补）', doc ? `\`${doc}\`` : '（待补）', skillLink,
    ]
    const merged = upsertTableRow(routeMd, ['模块', '顶级菜单'], 0, row)
    if (merged.ok) {
      if (!dryRun && merged.md !== routeMd) fs.writeFileSync(routeAbs, merged.md, 'utf8')
      if (merged.md !== routeMd) result.created.push(`${routeRel} §1`)
      else result.skipped.push(`${routeRel} §1（已存在该模块行）`)
    } else {
      result.warnings.push(`${routeRel} 里没找到「模块 | 顶级菜单」表 —— 请手工补一行`)
    }
  }

  // ---- 更新登记 ----
  if (!dryRun) {
    const { registry } = ensureRegistry(root, product, { pluginVersion })
    const mods = Array.isArray(registry.modules) ? [...registry.modules] : []
    const idx = mods.findIndex((m) => m?.name === module)
    const entry = {
      name: module,
      menu,
      menuPath,
      route,
      doc,
      version,
      skillPath: skillRel,
      registeredIn: ['AGENTS.md §三', `${CONFIG_DIR}\\模块路由.md`],
    }
    if (idx >= 0) mods[idx] = { ...mods[idx], ...entry }
    else mods.push(entry)
    registry.modules = mods
    registry.gates = recomputeGates(registry)
    writeRegistry(root, product, registry)
  }

  return result
}

/** 稳定 32 位哈希（给兜底 slug 用）。 */
function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

// ---------------------------------------------------------------------------
// 登记数据写入（环境 / 需求文档）
// ---------------------------------------------------------------------------

/**
 * 登记测试环境：写 `框架登记.json` + 往 `环境与账密.md` 的表里 upsert 行。
 *
 * ⚠️ 明文密码**只写进产品级规范 md**（用户自己的框架本来就这么放），
 * `框架登记.json` 里只记 `passwordStored` 指针，避免凭据散落两份。
 *
 * 两种调用方式都行：`recordEnvironments(root, product, [env])` 或 `recordEnvironments({ root, product, environments:[env] })`。
 */
export function recordEnvironments(rootOrOptions, product, environments, opts = {}) {
  const n = normalizeRecordArgs(rootOrOptions, product, environments, opts)
  const root = n.root
  const productName = n.product
  environments = n.list
  const { pluginVersion = 'unknown', dryRun = false } = n.options
  if (!Array.isArray(environments) || environments.length === 0) throw new Error('recordEnvironments 需要非空数组')
  const result = { written: [], warnings: [] }
  const { registry } = ensureRegistry(root, productName, { pluginVersion })
  const list = Array.isArray(registry.environments) ? [...registry.environments] : []

  const specRel = path.join(productName, CONFIG_DIR, '环境与账密.md')
  const specAbs = path.join(root, specRel)
  let md = readText(specAbs)
  if (md === undefined) result.warnings.push(`${specRel} 不存在（只写了框架登记.json）—— 请先跑脚手架`)

  for (const env of environments) {
    const name = String(env.name ?? '').trim()
    if (!name) {
      result.warnings.push('跳过一条没有 name 的环境记录')
      continue
    }
    const idx = list.findIndex((e) => e?.name === name)
    const entry = {
      name,
      url: env.url ?? '',
      dbHost: env.dbHost ?? '',
      dbPort: env.dbPort ?? '',
      dbName: env.dbName ?? '',
      schema: env.schema ?? '',
      account: env.account ?? '',
      passwordStored: `${CONFIG_DIR}\\环境与账密.md`,
      canWrite: env.canWrite ?? '未说明',
      note: env.note ?? '',
    }
    if (idx >= 0) list[idx] = { ...list[idx], ...entry }
    else list.push(entry)

    if (md !== undefined) {
      let merged = upsertTableRow(
        md,
        ['环境名', '页面入口'],
        1,
        [name, env.url ?? '', env.dbHost && env.dbPort ? `${env.dbHost}:${env.dbPort}` : (env.dbHost ?? ''), env.dbName ?? '', env.schema ?? '', env.note ?? ''],
      )
      if (!merged.ok) {
        merged = upsertTableRow(md, ['环境名', '库地址'], 1, [name, env.url ?? '', `${env.dbHost ?? ''}:${env.dbPort ?? ''}`, env.dbName ?? '', env.schema ?? '', env.note ?? ''])
      }
      if (!merged.ok) {
        result.warnings.push(`在 ${specRel} 里没找到测试环境表 —— 已追加到文件末尾，请手工挪进表里`)
        md = appendSection(md, `追加登记（${today()}）`,
          `| 环境名 | 页面入口 | 库地址 | 库名 | schema | 备注 |\n| --- | --- | --- | --- | --- | --- |\n`
          + `| ${name} | ${env.url ?? ''} | ${env.dbHost ?? ''}:${env.dbPort ?? ''} | ${env.dbName ?? ''} | ${env.schema ?? ''} | ${env.note ?? ''} |`)
      } else {
        md = merged.md
      }
      if (env.account || env.password) {
        const acc = upsertTableRow(md, ['账号', '密码'], 2, [name, env.account ?? '', env.password ?? '', env.canWrite ?? '', ''])
        if (acc.ok) md = acc.md
        else {
          md = appendSection(md, `页面账号（${today()}）`,
            `| 环境 | 角色 | 账号 | 密码 | 备注 |\n| --- | --- | --- | --- | --- |\n| ${name} | ${env.role ?? '（待补）'} | ${env.account ?? ''} | ${env.password ?? ''} | |`)
        }
      }
      if (env.dbUser || env.dbPassword) {
        const dba = upsertTableRow(md, ['用户名', '密码'], 1, [name, env.dbUser ?? '', env.dbPassword ?? '', env.canWrite ?? '', ''])
        if (dba.ok) md = dba.md
        else {
          md = appendSection(md, `数据库账号（${today()}）`,
            `| 环境 | 用户名 | 密码 | 只读/可写 | 备注 |\n| --- | --- | --- | --- | --- |\n| ${name} | ${env.dbUser ?? ''} | ${env.dbPassword ?? ''} | ${env.canWrite ?? ''} | |`)
        }
      }
    }
  }

  registry.environments = list
  registry.gates = recomputeGates(registry)
  if (!dryRun) {
    writeRegistry(root, productName, registry)
    result.written.push(path.join(productName, CONFIG_DIR, REGISTRY_FILE))
    if (md !== undefined) {
      fs.writeFileSync(specAbs, md, 'utf8')
      result.written.push(specRel)
    }
  }
  return result
}

/**
 * 统一 `recordDocuments` / `recordEnvironments` 的入参形状。
 *
 * 本模块里 `frameworkStatus` / `addModule` 用的是**对象参数**，而这两个登记函数原本是
 * **位置参数**（`root, product, list`）—— 两种形状并存，调用方极容易写错（实测就踩了两次）。
 * 所以这里两种都收：既 `(root, product, list)`，也 `({ root, product, documents })`。
 */
function normalizeRecordArgs(rootOrOptions, product, list, options = {}) {
  if (rootOrOptions && typeof rootOrOptions === 'object') {
    const o = rootOrOptions
    const payload = o.documents ?? o.environments ?? []
    return { root: o.root, product: o.product, list: payload, options: o }
  }
  return { root: rootOrOptions, product, list, options }
}

/**
 * 登记需求文档：文件名/系统/版本/页数/拆分出的模块/关联的其它文档/取消项核对结论。
 *
 * `split` 与 `relatedDocs` 是**闸门字段**：
 *   · `split` 为空数组 = 还没确认拆分 → 闸门拦住；
 *   · `relatedDocs` **缺 key** = 还没问过跨文档关联 → 闸门拦住；**空数组 = 问过了、用户答"没有"**。
 *
 * 两种调用方式都行：`recordDocuments(root, product, [doc])` 或 `recordDocuments({ root, product, documents:[doc] })`。
 */
export function recordDocuments(rootOrOptions, product, documents, opts = {}) {
  const n = normalizeRecordArgs(rootOrOptions, product, documents, opts)
  const root = n.root
  const productName = n.product
  documents = n.list
  const { pluginVersion = 'unknown', dryRun = false } = n.options
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('recordDocuments 需要非空数组')
  const result = { written: [], warnings: [] }
  const { registry } = ensureRegistry(root, productName, { pluginVersion })
  const list = Array.isArray(registry.documents) ? [...registry.documents] : []

  const ledgerRel = path.join(productName, CONFIG_DIR, '需求文档台账.md')
  const ledgerAbs = path.join(root, ledgerRel)
  let md = readText(ledgerAbs)
  if (md === undefined) result.warnings.push(`${ledgerRel} 不存在（只写了框架登记.json）—— 请先跑脚手架`)

  for (const doc of documents) {
    const name = String(doc.name ?? '').trim()
    if (!name) {
      result.warnings.push('跳过一条没有 name 的文档记录')
      continue
    }
    const idx = list.findIndex((d) => d?.name === name)
    const prev = idx >= 0 ? list[idx] : {}
    const entry = { ...prev }
    entry.name = name
    if (doc.system !== undefined) entry.system = doc.system
    if (doc.version !== undefined) entry.version = doc.version
    if (doc.pages !== undefined) entry.pages = doc.pages
    if (doc.path !== undefined) entry.path = doc.path
    entry.extractedAt = doc.extractedAt ?? prev.extractedAt ?? today()
    if (doc.split !== undefined) entry.split = doc.split
    // relatedDocs：**只有显式给了才写 key**（写空数组 = 用户答"没有"，是有效答案）
    if (Object.hasOwn(doc, 'relatedDocs')) entry.relatedDocs = doc.relatedDocs
    if (doc.splitConfirmed !== undefined) entry.splitConfirmed = doc.splitConfirmed
    if (doc.cancelledItemCheck !== undefined) entry.cancelledItemCheck = doc.cancelledItemCheck
    if (doc.note !== undefined) entry.note = doc.note
    if (idx >= 0) list[idx] = entry
    else list.push(entry)

    if (md !== undefined) {
      const splitText = Array.isArray(entry.split) ? entry.split.join(' / ') : ''
      const relatedText = Object.hasOwn(entry, 'relatedDocs')
        ? (Array.isArray(entry.relatedDocs) && entry.relatedDocs.length ? entry.relatedDocs.join('<br>') : '无')
        : '（未问）'
      const merged = upsertTableRow(
        md,
        ['文档名', '拆分出的模块'],
        1,
        [name, entry.system ?? '', entry.version ?? '', entry.pages ?? '', entry.extractedAt ?? '', splitText ? '是' : '否', splitText, relatedText, entry.note ?? ''],
      )
      if (merged.ok) md = merged.md
      else {
        result.warnings.push(`在 ${ledgerRel} 里没找到文档台账表 —— 已追加到文件末尾，请手工挪进表里`)
        md = appendSection(md, `追加登记（${today()}）`,
          `| 文档名 | 所属系统 | 版本 | 页数 | 抽取日期 | 是否已拆分 | 拆分出的模块 | 关联的其它需求文档 | 备注 |\n`
          + `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`
          + `| ${name} | ${entry.system ?? ''} | ${entry.version ?? ''} | ${entry.pages ?? ''} | ${entry.extractedAt ?? ''} | ${splitText ? '是' : '否'} | ${splitText} | ${relatedText} | ${entry.note ?? ''} |`)
      }
    }
  }

  registry.documents = list
  registry.gates = recomputeGates(registry)
  if (!dryRun) {
    writeRegistry(root, productName, registry)
    result.written.push(path.join(productName, CONFIG_DIR, REGISTRY_FILE))
    if (md !== undefined) {
      fs.writeFileSync(ledgerAbs, md, 'utf8')
      result.written.push(ledgerRel)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 状态扫描
// ---------------------------------------------------------------------------

/**
 * 扫描框架现状。这是所有工具与提示词闸门的**唯一状态来源**。
 *
 * @param {object} [options]
 * @param {string} [options.root] 起点（默认 cwd）
 * @param {string} [options.product] 只看某个产品
 */
export function frameworkStatus(options = {}) {
  const start = path.resolve(options.root ?? process.cwd())
  const found = findFrameworkRoot(start)
  const projectRoot = findProjectRoot(start)
  const theme = {
    cwd: start,
    frameworkRoot: found?.root ?? null,
    detectedVia: found?.via ?? null,
    projectRoot: projectRoot ?? null,
    // DSH 的 findProjectRoot 只认 .git：框架根 != 项目根 ⇒ AGENTS.md 在子目录开会话时不会被自动加载
    agentsMdAutoLoaded: Boolean(found && projectRoot && path.resolve(projectRoot) === path.resolve(found.root)),
    warnings: [],
    products: [],
    // 前置条件（外部 MCP）—— **playwright 是必需的，且没有替代路径**（用户 2026-10-14 口径：
    // "强制要求使用 playwright MCP"）。所以它必须能被**检查**，缺了要直接说"先配好再开工"，
    // 不能等用户要求"看着我操作"时才发现工具不存在。
    // 传 `skipPrereq: true` 可跳过（测试用，避免断言依赖跑测机器上配没配 MCP）。
    prereqs: options.skipPrereq
      ? null
      : (() => {
        try {
          return checkPrerequisites({ dshHome: options.dshHome, profile: options.profile })
        } catch {
          return null
        }
      })(),
    // 防干扰（隔离）—— 「**别的项目 / 别的框架在影响本框架**」必须在**会话开头**就看得见，
    // 而不是等模块里被建出一堆永远装不进东西的 `temps\` 空壳才发现（2026-10-14 加）。
    // 传 `skipIsolation: true` 可跳过（测试用，避免断言依赖跑测机器上的目录长相）。
    isolation: (options.skipIsolation || !found)
      ? null
      : (() => {
        try {
          return checkIsolation({ root: found.root, projectRoot, cwd: start })
        } catch {
          return null
        }
      })(),
  }
  if (!found) {
    theme.warnings.push('当前目录向上找不到「测试框架根」（要有 AGENTS.md + _templates/skills，或有 .dsh-test-framework.json）。'
      + '要初始化请调 test_framework_init。')
    return theme
  }
  if (!theme.agentsMdAutoLoaded) {
    // ⚠️ 两种情况**别混为一谈**（2026-10-14 修）：框架根自己**有** `.git`、而框架树**内部**有嵌套仓库时，
    // 项目根会被截断到那儿 —— 此时说"框架根不含 .git"是**误诊**（实测：在 `_plugin\dsh-test-framework\`
    // 里开会话就会撞上）。诊断细节交给 `isolation`，这里只说结论。
    const hasGitAtRoot = exists(path.join(found.root, '.git'))
    if (hasGitAtRoot && theme.isolation?.contract?.truncatedBy) {
      theme.warnings.push(
        `项目根被**嵌套仓库**截断到 \`${theme.isolation.contract.truncatedBy}\` —— `
        + '本会话不会自动加载框架根 AGENTS.md。在这种目录里干活前**先手动读它**。',
      )
    } else if (!hasGitAtRoot) {
      theme.warnings.push(
        `框架根（${found.root}）不含 .git，DSH 认不到它是项目根 —— `
        + '框架根 AGENTS.md 不会自动加载，框架级 skill 也可能不加载。跑 test_framework_init 可补。',
      )
    } else {
      theme.warnings.push(
        `项目根解析结果（${theme.projectRoot ?? '无'}）不是框架根（${found.root}）—— `
        + '本会话可能不会自动加载框架根 AGENTS.md。',
      )
    }
  }
  const productNames = options.product ? [options.product] : listProducts(found.root)
  if (options.product && !exists(path.join(found.root, options.product))) {
    theme.warnings.push(`产品目录不存在：${path.join(found.root, options.product)}`)
  }
  for (const product of productNames) {
    const { registry, warnings } = readRegistry(found.root, product)
    theme.warnings.push(...warnings)
    const modules = listModules(path.join(found.root, product)).map((name) => ({
      name,
      dir: path.join(found.root, product, name),
      hasSkill: isFile(path.join(found.root, product, name, 'SKILL.md')),
    }))
    const safeRegistry = registry ?? emptyRegistry({ product, frameworkRoot: found.root })
    theme.products.push({
      name: product,
      dir: path.join(found.root, product),
      configDir: configDirOf(found.root, product),
      registryFile: path.join(configDirOf(found.root, product), REGISTRY_FILE),
      registry: registry ?? null,
      modules,
      documents: safeRegistry.documents ?? [],
      environments: safeRegistry.environments ?? [],
      gates: recomputeGates(safeRegistry),
      missing: registry ? missingItems(safeRegistry) : [{ key: 'registry', ask: '本产品还没有框架登记（框架登记.json）—— 跑 test_framework_init。' }],
      ready: Boolean(registry) && missingItems(safeRegistry).length === 0,
    })
  }
  return theme
}

/**
 * 渲染「闸门」文本 —— 注入系统提示词/动态上下文的那段。
 *
 * 空字符串 = 没有需要提醒的（此时 DSH 会把空上下文丢掉，不占 token）。
 */
export function renderGate(status) {
  if (!status) return ''
  const lines = []
  if (!status.frameworkRoot) {
    return [
      '## 测试框架（dsh-test-framework 插件）',
      '',
      '当前工作区**还没有初始化测试框架**。若用户要做需求测试/冒泡测试/连库造数，',
      '先调 `test_framework_init` 把骨架落到这个文件夹，再按 `test-framework-onboard` 流程走。',
      '用户只是随便提问、或明确说不要框架时，忽略本段。',
    ].join('\n')
  }
  const pending = status.products.filter((p) => !p.ready)
  // ⚠️ 前置条件（必需的外部 MCP）**不满足时，即使登记全对也不能整段跳过** ——
  // 否则"没配 playwright MCP"会被"登记没问题"掩盖掉，等真要"看着操作"时才炸。
  const prereq = renderPrereqBlock(status.prereqs)
  // 同理：**别的项目/别的框架正在影响本框架**（契约被嵌套仓库截断、项目根跑到框架外面、
  // 模块里被塞进外部工具的工作目录）也必须在会话开头就说 —— 登记全对不代表没被干扰。
  const isolation = renderIsolationBlock(status.isolation)
  if (pending.length === 0 && status.agentsMdAutoLoaded && !prereq && !isolation) return ''
  lines.push('## 测试框架状态（dsh-test-framework 插件自动生成）')
  lines.push('')
  lines.push(`框架根：\`${status.frameworkRoot}\``)
  if (!status.agentsMdAutoLoaded) {
    // 契约问题（没 .git / 被嵌套仓库截断 / 项目根在框架外）若已由 isolation 段说清，这里不重复。
    const covered = Boolean(status.isolation?.items?.some(
      (i) => i.key === 'no-git' || i.key === 'contract-truncated' || i.key === 'contract-foreign',
    ))
    if (!covered) {
      lines.push('')
      lines.push('⚠️ **框架根没有 `.git`** —— DSH 认不到它是项目根，根目录 `AGENTS.md` 不会被自动加载。'
        + '干活前请**主动读**它（`read`），或先跑 `test_framework_init` 补上根标记。')
    }
  }
  if (pending.length) {
    lines.push('')
    lines.push('⚠️ **框架登记不完整 → 不许直接开测**。缺的项：')
    for (const p of pending) {
      lines.push(`- 产品「${p.name}」缺 ${p.missing.length} 项：`)
      for (const m of p.missing) lines.push(`  - ${m.ask}`)
    }
    lines.push('')
    lines.push('处置：用 `ask_user_question` 把上面每条**一次问清**（别一条条挤牙膏），'
      + '拿到答案后调 `test_framework_record` / `test_framework_module_add` 登记，再开始测试。'
      + '完整流程见 skill `test-framework-onboard`。')
  }
  if (prereq) {
    lines.push('')
    lines.push(prereq)
  }
  if (isolation) {
    lines.push('')
    lines.push(isolation)
  }
  return lines.join('\n')
}

export { TEMPLATE_ROOT }
