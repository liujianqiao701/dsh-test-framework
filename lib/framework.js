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
import { checkPromptBudget, renderBudgetBlock, LEVEL_OK as BUDGET_OK } from './budget.js'

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

/**
 * 一份空登记。
 *
 * 三个新顶层键（0.3.0 起）—— 支撑「模块 = 叶子菜单 + 每个模块带端与逻辑业务对象」这套新口径：
 *   · `ends[]`：端清单（中心端 / 成员端 / 患者端 …），其中一个标 `default: true`；
 *   · `relations[]`：跨端/上下游的**关联边**（模块 ↔ 模块，双向应各有一条）；
 *   · `flows[]`：链路（把若干条边串起来，用于校验链条完整）。
 */
export function emptyRegistry({ product, frameworkRoot, pluginVersion = 'unknown' }) {
  return {
    schema: REGISTRY_SCHEMA,
    product,
    frameworkRoot,
    createdBy: 'dsh-test-framework 插件自动生成',
    pluginVersion,
    updatedAt: today(),
    ends: [],
    documents: [],
    environments: [],
    modules: [],
    relations: [],
    flows: [],
    gates: {
      documentsRegistered: false,
      versionsConfirmed: false,
      crossDocChecked: false,
      splitConfirmed: false,
      environmentRegistered: false,
      modulesRegistered: false,
      linksChecked: false,
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

// ---------------------------------------------------------------------------
// 端 / 关联边（跨端业务关联）—— 模块 = 叶子菜单，每个模块带「端」与「逻辑业务对象」
// ---------------------------------------------------------------------------

/** 文本归一：任何值 → 去空白字符串（`undefined` → `''`）。 */
function asText(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * 登记里的端清单 + 默认端名（容错：老登记没有 `ends` 时返回空表）。
 *
 * 端名的字段名两种都吃：`name`（插件自己写的）与 `key`（人手写的产品登记里更常见）——
 * 读错字段名会让"默认端"变成空串，于是**每个模块都被当成非默认端**、凭空报一片端前缀错误。
 */
export function endsOf(registry) {
  const raw = Array.isArray(registry?.ends) ? registry.ends : []
  const list = raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      ...e,
      name: asText(e.name) || asText(e.key),
      default: e.default === true || e.isDefault === true,
    }))
    .filter((e) => e.name !== '')
  const marked = list.find((e) => e.default)
  return { list, defaultName: marked ? marked.name : (list.length ? list[0].name : '') }
}

/**
 * 这个端算不算「非默认端」。
 *
 * 口径：`end` 缺省 / 空 = 默认端（模块名不带前缀）；显式写了别的端名 = 非默认端
 * （**包括写了 `ends[]` 里没登记过的端名** —— 那更要按非默认端要求前缀，否则名字规则没法自洽）。
 */
export function isNonDefaultEnd(registry, endName) {
  const name = asText(endName)
  if (name === '') return false
  const { defaultName } = endsOf(registry)
  return name !== defaultName
}

/** `businessObjects` 归一：字符串 / 数组 / 中英文逗号顿号分号分隔都要能吃、去重保序。 */
export function normalizeBusinessObjects(value) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of raw) {
    if (item === undefined || item === null) continue
    for (const part of String(item).split(/[,，、;；]/)) {
      const v = part.trim()
      if (v !== '' && !out.includes(v)) out.push(v)
    }
  }
  return out
}

/** 把值统一成字符串数组（`sharedTables` / `accounts` 这类多值字段用）。 */
function asTextArray(value) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw.map((v) => asText(v)).filter((v) => v !== '')
}

/** `routes` / 扁平的两字段归一成 `{ from, to }`（只留非空串）。 */
function normalizeRoutes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  const from = asText(value.from)
  const to = asText(value.to)
  if (from) out.from = from
  if (to) out.to = to
  return out
}

/** 扁平的规范字段 `fromRoute` / `toRoute` → `{ from, to }`（两个都空时返回 `undefined`）。 */
function routesFromFlat(fromRoute, toRoute) {
  const from = asText(fromRoute)
  const to = asText(toRoute)
  if (from === '' && to === '') return undefined
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/**
 * `links` 归一：元素可以是**模块名字符串**，也可以是对象。
 *
 * 字符串元素归一成 `{ to: <名>, kind: '关联' }` —— 只写"我跟谁有关联"这一件事，
 * 其余字段（交接点 / 共享表 / 对端路由 …）等对方那份登记或后续补录。
 *
 * 入参字段名**两种都收**：插件原名（`sharedTables` / `routes`）与
 * 产品登记的**规范名**（`tables` / `fromRoute` / `toRoute` / `note`）。
 *
 * ⚠️ **本次没给的字段一律留空 / 不出现在结果里**（`kind` / `status` 也不臆造默认值）——
 * 写侧（`applyModuleLinks`）靠"给没给"来决定**沿用已有登记**还是覆盖，臆造默认值会把
 * 手写的 `已确认` 降级成 `待核`。默认值（`关联` / `待核`）由写侧在"新建这条边"时才补。
 */
export function normalizeLinks(value) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const to = item.trim()
      // 字符串简写 = 明确表达"这条边就是「关联」"，给上默认值
      if (to !== '') out.push({ to, kind: '关联' })
      continue
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const to = asText(item.to) || asText(item.module)
      if (to === '') continue
      const routeBox = normalizeRoutes(item.routes)
      out.push({
        to,
        kind: asText(item.kind),
        businessObject: item.businessObject,
        handoff: item.handoff,
        sharedTables: normalizeTables(item),
        // 规范名的**原文**留着：人手写的 `fromRoute` 常带散文/反引号，回写时不该被规范化掉
        tablesRaw: asText(item.tables),
        routes: Object.keys(routeBox).length ? routeBox : routesFromFlat(item.fromRoute, item.toRoute),
        fromRouteRaw: asText(item.fromRoute),
        toRouteRaw: asText(item.toRoute),
        nameVariance: item.nameVariance,
        accounts: item.accounts,
        evidence: item.evidence,
        status: item.status,
        note: item.note,
        noteRaw: asText(item.note),
        flow: item.flow,
        id: item.id,
      })
    }
  }
  return out
}

/** 把一串表名（`tables` 规范名的值）拆成数组：`<br>` / 换行 / 顿号逗号分号竖线都能吃，反引号与空白去掉。 */
function splitTables(value) {
  return asText(value)
    .split(/<br\s*\/?>|\r?\n|[、,，;；|]/)
    .map((v) => v.replace(/[`\s]/g, ''))
    .filter((v) => v !== '')
}

/**
 * 共享表的两种入参归一成数组：`sharedTables`（数组，插件原名）/ `tables`（字符串，规范名，可带反引号与分隔符）。
 */
function normalizeTables(item) {
  const own = asTextArray(item.sharedTables)
  if (own.length) return own
  const flat = asText(item.tables)
  if (flat === '') return undefined
  return splitTables(flat)
}

/** 关联边的稳定 id：`from|to|businessObject` 的稳定哈希（复用 `hash32`）。 */
export function relationId(from, to, businessObject = '') {
  return `R-${Math.abs(hash32(`${asText(from)}|${asText(to)}|${asText(businessObject)}`)).toString(36)}`
}

/**
 * 判两条边是不是"同一件事"的同一个业务口径。
 *
 * `businessObject` / `flow` **空视为通配**：只登记了方向、还没补业务对象时，
 * 不许凭"空 vs 非空"造出「单向边」这种误报（宁可少报一条，也不许误拦）。
 */
function sameWildcard(a, b) {
  const x = asText(a)
  const y = asText(b)
  return x === '' || y === '' || x === y
}

/** 边的定位键：`from|to|businessObject|flow`（addModule 幂等 upsert 用）。 */
export function relationKey(relation) {
  return [
    asText(relation?.from),
    asText(relation?.to),
    asText(relation?.businessObject),
    asText(relation?.flow),
  ].join('\u0000')
}

/**
 * **只依赖 registry** 的关联校验（不读磁盘）—— 闸门 `linksChecked` 用的就是这一份。
 *
 * 覆盖三类"纯登记就能判"的问题：`E_ONE_WAY` / `E_FLOW_BROKEN` / `E_END_PREFIX`，
 * 外加四条信息性告警：`W_NO_BUSINESS_OBJECT` / `W_REGISTERED_IN` / `W_DUPLICATE_MODULE` / `W_WHOLE_END_MODULE`。
 *
 * @returns {{ errors: object[], warnings: object[] }}
 */
export function registryLinkIssues(registry) {
  const reg = registry ?? {}
  const mods = (Array.isArray(reg.modules) ? reg.modules : []).filter((m) => m && asText(m.name) !== '')
  const rels = (Array.isArray(reg.relations) ? reg.relations : []).filter((r) => r && typeof r === 'object')
  const flows = (Array.isArray(reg.flows) ? reg.flows : []).filter((f) => f && typeof f === 'object')
  const { list: ends, defaultName } = endsOf(reg)
  const errors = []
  const warnings = []

  // ---- 每个模块：端前缀 + 业务对象 + 登记落点 ----
  for (const m of mods) {
    const name = asText(m.name)
    const end = asText(m.end)
    const nonDefault = isNonDefaultEnd(reg, end)
    // 例外：**整端就是一个模块**（端不拆模块，如只有一个 H5 的患者端）→ 目录名直接用端名，
    // 不能再要求 `<端>-` 前缀（那会变成 `患者端-患者端`）。判据：模块名 == 它自己声明的端名。
    const isWholeEnd = end !== '' && name === end
    if (nonDefault && !isWholeEnd) {
      if (!name.startsWith(`${end}-`)) {
        errors.push({
          code: 'E_END_PREFIX',
          level: 'error',
          target: name,
          message: `模块「${name}」声明了非默认端「${end}」，目录名必须以「${end}-」开头（= <端>-<逻辑业务对象>）。`
            + `（整端就是一个模块时才允许目录名 == 端名「${end}」；那是例外，得在 \`模块关联.md\` §1 写明。）`,
        })
      }
    } else if (isWholeEnd) {
      warnings.push({
        code: 'W_WHOLE_END_MODULE',
        level: 'warning',
        target: name,
        message: `模块「${name}」是**整端一个模块**（端名 == 模块名）—— 这是允许的例外，但要在 \`模块关联.md\` §1 写明`
          + '「该端不拆模块、用 `businessObjects` 表达」；关联边的 `from`/`to` 可以直接写这个端名。',
      })
    } else {
      const hit = ends.find((e) => name.startsWith(`${e.name}-`))
      if (hit) {
        errors.push({
          code: 'E_END_PREFIX',
          level: 'error',
          target: name,
          message: `模块「${name}」属于默认端${defaultName ? `「${defaultName}」` : ''}，目录名不应带端前缀 —— 去掉「${hit.name}-」。`,
        })
      }
    }

    const bos = asTextArray(m.businessObjects)
    if (nonDefault && bos.length === 0) {
      warnings.push({
        code: 'W_NO_BUSINESS_OBJECT',
        level: 'warning',
        target: name,
        message: `模块「${name}」（端：${end || '（未写）'}）没登记 \`businessObjects\` —— 非默认端模块要写明它对应哪个**逻辑业务对象**（跨端对齐靠它）。`,
      })
    }

    const where = asTextArray(m.registeredIn)
    const missingWhere = []
    if (!where.some((w) => w.includes('AGENTS.md'))) missingWhere.push('AGENTS.md §三')
    if (!where.some((w) => w.includes('模块路由'))) missingWhere.push(`${CONFIG_DIR}\\模块路由.md`)
    if (missingWhere.length) {
      warnings.push({
        code: 'W_REGISTERED_IN',
        level: 'warning',
        target: name,
        message: `模块「${name}」的 \`registeredIn\` 缺：${missingWhere.join('、')} —— 两处都要登记，否则会话里读不到它。`,
      })
    }
  }

  // ---- W_DUPLICATE_MODULE：同一个模块在 modules[] 里出现多条（去重是登记卫生，不拦人） ----
  const seenModule = new Set()
  for (const m of mods) {
    const name = asText(m.name)
    if (seenModule.has(name)) {
      warnings.push({
        code: 'W_DUPLICATE_MODULE',
        level: 'warning',
        target: name,
        message: `\`modules[]\` 里「${name}」重复登记了多条 —— 去重成一条（同一模块只该有一个条目，否则两处的 end / 路由可能互相打架）。`,
      })
    }
    seenModule.add(name)
  }

  // ---- E_ONE_WAY：有 A→B，却没有同业务口径的 B→A ----
  const reported = new Set()
  for (const r of rels) {
    const from = asText(r.from)
    const to = asText(r.to)
    if (from === '' || to === '' || from === to) continue
    const back = rels.some((q) => q !== r
      && asText(q.from) === to && asText(q.to) === from
      && sameWildcard(q.businessObject, r.businessObject)
      && sameWildcard(q.flow, r.flow))
    if (back) continue
    const key = `${from}\u0000${to}\u0000${asText(r.businessObject)}\u0000${asText(r.flow)}`
    if (reported.has(key)) continue
    reported.add(key)
    errors.push({
      code: 'E_ONE_WAY',
      level: 'error',
      target: `${from} → ${to}`,
      message: `只有单向关联边「${from} → ${to}」，缺反向边「${to} → ${from}」`
        + `（判据：businessObject=「${asText(r.businessObject)}」、flow=「${asText(r.flow)}」）`
        + '。跨端关联**两端必须都能查到**：在对方模块登记它的 `links`，或补一条 relations[]。',
    })
  }

  // ---- E_FLOW_BROKEN：链路的相邻两跳必须有对应的关系边 ----
  for (const f of flows) {
    // 链路节点两种字段名都吃：`order`（插件写的）/ `nodes`（人手写的登记里更常见）
    const orderNodes = asTextArray(f.order)
    const order = orderNodes.length ? orderNodes : asTextArray(f.nodes)
    const flowName = asText(f.name) || '（未命名链路）'
    for (let i = 0; i + 1 < order.length; i += 1) {
      const a = order[i]
      const b = order[i + 1]
      const hit = rels.some((r) => asText(r.from) === a && asText(r.to) === b)
      if (!hit) {
        errors.push({
          code: 'E_FLOW_BROKEN',
          level: 'error',
          target: `${flowName}：${a} → ${b}`,
          message: `链路「${flowName}」的第 ${i + 1}→${i + 2} 跳「${a} → ${b}」没有对应的关联边（relations[]）—— 链条断了。`,
        })
      }
    }
  }

  return { errors, warnings }
}

/** `模块路由.md` 里「模块 → 页面路由」的对照表（拿去核 `relations[].routes` 有没有漂移）。 */
function readModuleRoutes(root, product) {
  const out = new Map()
  const md = readText(path.join(root, product, CONFIG_DIR, '模块路由.md'))
  if (md === undefined) return out
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i]
    if (!header.trim().startsWith('|')) continue
    if (!header.includes('模块') || !header.includes('顶级菜单')) continue
    if (!DELIMITER_ROW.test(lines[i + 1] ?? '')) continue
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
      const cells = splitRow(lines[j])
      const name = asText(cells[0])
      // 路由列按"填没填"判：`（待补）` 这类占位符等于**没填**，不能拿去跟关联边比对
      const route = normalizeRoute(cells[4])
      if (name && route && !PLACEHOLDER_CELLS.has(name)) out.set(name, route)
    }
    break
  }
  return out
}

/** 路由值的有效化：占位符 / 破折号当成"没填"。 */
function normalizeRoute(value) {
  const v = asText(value)
  if (v === '' || PLACEHOLDER_CELLS.has(v) || v === '—' || v === '——') return ''
  return v
}

/**
 * 扁平路由字段（`fromRoute` / `toRoute`）**像不像一条路由**。
 *
 * 人手写的登记里这两个字段常常装的是**入口描述**（菜单路径、`H5 /CPR/patient/…` 之类），
 * 拿它去比对 `模块路由.md` 的「页面路由」必然对不上 —— 那就不是"漂移"，是**两个字段口径不同**。
 * 所以只认**以 `/` 开头的路由片段**（`/drugStorage`、`` `/drugStorage`（待审核） ``）。
 */
function looksLikeRoute(value) {
  return routePathOf(value) !== ''
}

/**
 * 从一段可能夹着散文的路由里取出**路径**（忽略协议前缀、反引号、参数、`<占位符>` 与说明文字）。
 *
 * 为什么不能整串比：真实登记里两边常写成 ``H5 `/CPR/patient/?orgCode=<机构>` `` 与
 * `` `/CPR/patient/?orgCode=<机构编码>` `` —— 整串比必然"对不上"，但**路径其实是同一条**，
 * 那是措辞差异不是路由漂移（真机上就是这么误报的）。所以只比**第一个 `/` 路径段**（`?` 之前的部分）。
 */
function routePathOf(value) {
  const m = /\/[A-Za-z][A-Za-z0-9_\-/]*/.exec(asText(value))
  if (!m) return ''
  const seg = m[0].split('?')[0].replace(/\/+$/, '')
  return seg === '' || seg === '/' ? '' : seg
}

/**
 * 跨端业务关联的**只读**校验：`{ ok, errors, warnings, summary }`。
 *
 * 每条问题形如 `{ code, level, target, message }`。
 * `ok` 只由**错误**决定（warning 不影响 ok）—— 路由漂移这类"复合串容易误报"的判据
 * 刻意只算 warning，不许凭它拦人。
 *
 * ⚠️ **只读**：不改任何文件、不写登记。
 */
export function checkLinks({ root, product } = {}) {
  const rootAbs = path.resolve(root ?? process.cwd())
  const productName = asText(product)
  const result = {
    ok: true,
    errors: [],
    warnings: [],
    summary: { root: rootAbs, product: productName, modules: 0, relations: 0, flows: 0, ends: 0, byEnd: {} },
  }
  if (productName === '') {
    result.ok = false
    result.errors.push({ code: 'E_REGISTRY_MISSING', level: 'error', target: '', message: 'checkLinks 需要 product（产品名）。' })
    return result
  }
  const { registry, warnings: readWarnings } = readRegistry(rootAbs, productName)
  if (!registry) {
    result.ok = false
    result.errors.push({
      code: 'E_REGISTRY_MISSING',
      level: 'error',
      target: path.join(rootAbs, productName, CONFIG_DIR, REGISTRY_FILE),
      message: `读不到该产品的框架登记（${readWarnings.join('；') || '文件不存在'}）—— 先跑脚手架/登记，再来校验关联。`,
    })
    return result
  }

  const pure = registryLinkIssues(registry)
  result.errors.push(...pure.errors)
  result.warnings.push(...pure.warnings)

  const mods = (Array.isArray(registry.modules) ? registry.modules : []).filter((m) => m && asText(m.name) !== '')
  const rels = (Array.isArray(registry.relations) ? registry.relations : []).filter((r) => r && typeof r === 'object')
  const flows = (Array.isArray(registry.flows) ? registry.flows : []).filter((f) => f && typeof f === 'object')
  const { list: ends, defaultName } = endsOf(registry)
  const modNames = new Set(mods.map((m) => asText(m.name)))
  const endNames = new Set(ends.map((e) => e.name))
  const mdRoutes = readModuleRoutes(rootAbs, productName)

  // ---- E_MODULE_MISSING：边的两端必须在 modules[] 里，且磁盘上真有那个模块目录 ----
  const missingSeen = new Set()
  const pushMissing = (target, message) => {
    const key = `${target}\u0000${message}`
    if (missingSeen.has(key)) return
    missingSeen.add(key)
    result.errors.push({ code: 'E_MODULE_MISSING', level: 'error', target, message })
  }
  for (const r of rels) {
    for (const side of ['from', 'to']) {
      const name = asText(r[side])
      if (name === '') {
        pushMissing(`${asText(r.from)} → ${asText(r.to)}`, `relations[] 里有一条边的 \`${side}\` 是空的 —— 补上模块名。`)
        continue
      }
      if (!modNames.has(name)) {
        // 端名也是链路里的**合法节点**：有的端（如 H5 患者端）整端不拆模块，
        // 于是它以端名出现在 from/to 里。只认模块名会把这种登记全判成"模块缺失"（误报一片）。
        if (endNames.has(name)) continue
        pushMissing(name, `关联边的 \`${side}\`=「${name}」在 \`${REGISTRY_FILE}\` 的 \`modules[]\` 里找不到 —— 先登记这个模块（也不是 \`ends[]\` 里的端名）。`)
        continue
      }
      if (!isDir(path.join(rootAbs, productName, name))) {
        pushMissing(name, `模块「${name}」已在 \`modules[]\` 里登记，但磁盘上没有目录 \`${path.join(productName, name)}\` —— 建目录或改登记。`)
      }
    }
  }

  // ---- W_ROUTE_DRIFT：边上的两端路由 vs 模块登记的路由（只算 warning） ----
  for (const r of rels) {
    const routeBox = r.routes && typeof r.routes === 'object' ? r.routes : undefined
    // 路由的两种写法都吃：`routes: {from,to}`（插件写的）/ 扁平的 `fromRoute` / `toRoute`（人手写的登记里更常见）。
    // 扁平那两个**只在真的像路由时**才拿来比对 —— 它们经常装的是菜单路径/入口描述（见 looksLikeRoute）。
    const flatOf = (side) => asText(side === 'from' ? r.fromRoute : r.toRoute)
    const claimedOf = (side) => {
      if (routeBox) return normalizeRoute(routeBox[side])
      const flat = flatOf(side)
      return looksLikeRoute(flat) ? normalizeRoute(flat) : ''
    }
    if (!routeBox && !looksLikeRoute(r.fromRoute) && !looksLikeRoute(r.toRoute)) continue
    for (const side of ['from', 'to']) {
      const claimed = claimedOf(side)
      if (claimed === '') continue
      const name = asText(r[side])
      const mod = mods.find((m) => asText(m.name) === name)
      const actual = normalizeRoute(mod?.route) || mdRoutes.get(name) || ''
      if (actual === '') continue // 模块那边没写路由 → 无从比对，不报
      // 比对**路径**（`?` 之前的部分），不比整串：两边常有一段说明文字 / `<机构编码>` 这类占位符差异，
      // 整串比会把"同一条路由的两种写法"报成漂移（真机上就是这么误报的）；路径不同才是真漂移。
      const claimedPath = routePathOf(claimed)
      const actualPath = routePathOf(actual)
      if (claimedPath !== '' && actualPath !== '') {
        if (claimedPath === actualPath) continue
      } else if (claimed.includes(actual) || actual.includes(claimed)) {
        continue
      }
      result.warnings.push({
        code: 'W_ROUTE_DRIFT',
        level: 'warning',
        target: `${name}（${side}）`,
        message: `关联边的 \`routes.${side}\`=「${claimed}」与模块登记的路由「${actual}」**对不上**`
          + '（判据：两边非空且互不包含；复合串容易误报，所以只算 warning）—— 改了路由记得回填 `模块关联.md`。',
      })
    }
  }

  const byEnd = {}
  for (const m of mods) {
    const end = asText(m.end) || defaultName || '（未写端）'
    byEnd[end] = (byEnd[end] ?? 0) + 1
  }
  result.summary = {
    root: rootAbs,
    product: productName,
    modules: mods.length,
    relations: rels.length,
    flows: flows.length,
    ends: ends.length,
    defaultEnd: defaultName,
    byEnd,
    errors: result.errors.length,
    warnings: result.warnings.length,
  }
  result.ok = result.errors.length === 0
  return result
}

/**
 * 按登记内容**重算** gates（不信任手工填的值 —— 这是闸门能不能拦住人的关键）。
 *
 * 注意「跨文档关联」用 `hasOwnProperty` 判：用户答「没有」要写成 `relatedDocs: []`（= 问过了），
 * 缺这个 key 才等于「没问」。两者不能混。
 *
 * `linksChecked`（0.3.0 起）= **纯登记就能判**的关联问题为零，即 `E_ONE_WAY` / `E_FLOW_BROKEN` /
 * `E_END_PREFIX` 三类。**刻意不含** `E_MODULE_MISSING` —— 那条要读磁盘，是两个不同层次的事实
 * （它在 `missingItems` 里单独体现）。另加一条宽松条件：没有任何模块声明非默认端、也没有任何
 * `relations[]` 时**视为通过**，免得老产品一升级就被这条拦住。
 */
export function recomputeGates(registry) {
  const reg = registry ?? {}
  const docs = Array.isArray(reg.documents) ? reg.documents : []
  const envs = Array.isArray(reg.environments) ? reg.environments : []
  const mods = Array.isArray(reg.modules) ? reg.modules : []
  const rels = Array.isArray(reg.relations) ? reg.relations : []
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '' && v !== '（待补）'
  const hasNonDefaultEnd = mods.some((m) => m && isNonDefaultEnd(reg, m?.end))
  const hasRelations = rels.length > 0
  const linksChecked = (!hasNonDefaultEnd && !hasRelations) || registryLinkIssues(reg).errors.length === 0
  return {
    documentsRegistered: docs.length > 0,
    versionsConfirmed: docs.length > 0 && docs.every((d) => nonEmpty(d?.version)),
    crossDocChecked: docs.length > 0 && docs.every((d) => Object.hasOwn(d ?? {}, 'relatedDocs')),
    splitConfirmed:
      docs.length > 0 && docs.every((d) => Array.isArray(d?.split) && d.split.length > 0 && d?.splitConfirmed !== false),
    environmentRegistered: envs.length > 0,
    modulesRegistered: mods.length > 0,
    linksChecked,
  }
}

/** 缺哪些、缺了怎么办 —— 直接可渲染成给用户看的提问清单。 */
export function missingItems(registry) {
  const reg = registry ?? {}
  const gates = recomputeGates(reg)
  const docs = Array.isArray(reg.documents) ? reg.documents : []
  const mods = Array.isArray(reg.modules) ? reg.modules : []
  const rels = Array.isArray(reg.relations) ? reg.relations : []
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
  // ---- 关联登记（0.3.0 起）：模块 ↔ 模块 的跨端 / 上下游业务关联 ----
  if (!gates.linksChecked) {
    const involved = []
    for (const m of mods) {
      const name = asText(m?.name)
      if (name === '') continue
      const involvedHere = isNonDefaultEnd(reg, m?.end) || rels.some((r) => asText(r?.from) === name || asText(r?.to) === name)
      if (involvedHere && !involved.includes(name)) involved.push(name)
    }
    if (involved.length === 0) {
      for (const r of rels) for (const side of ['from', 'to']) {
        const name = asText(r?.[side])
        if (name !== '' && !involved.includes(name)) involved.push(name)
      }
    }
    const codes = [...new Set(registryLinkIssues(reg).errors.map((e) => e.code))]
    out.push({
      key: 'linksChecked',
      ask: `这些模块声明了非默认端或有关联边，但关联登记不完整：${involved.join('、') || '（见 relations[]）'}。`
        + '请补齐『它与哪个模块有业务关联（另一端叫什么名字、哪个环节交接、共享哪张表）』，或明确回答『没有关联』。'
        + (codes.length ? `（未过的判据：${codes.join(' / ')} —— 跑 \`test_framework_link\` 看逐条明细。）` : ''),
    })
  }
  // 需要读磁盘的那一类（`E_MODULE_MISSING`）不在 gates 里，但同样要摆到提问清单上。
  const diskMissing = (() => {
    try {
      const root = asText(reg.frameworkRoot)
      const productName = asText(reg.product)
      if (root === '' || productName === '') return []
      if (!isFile(path.join(configDirOf(root, productName), REGISTRY_FILE))) return []
      return checkLinks({ root, product: productName }).errors.filter((e) => e.code === 'E_MODULE_MISSING')
    } catch {
      return []
    }
  })()
  if (diskMissing.length) {
    const targets = [...new Set(diskMissing.map((e) => e.target).filter(Boolean))]
    out.push({
      key: 'linksModuleMissing',
      ask: `关联边指向的模块**在磁盘上或 modules[] 里不存在**：${targets.join('、') || '（见明细）'}。`
        + '请补齐模块目录与登记，或把这条关联边改掉（明细：跑 `test_framework_link`）。',
    })
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
// §关联模块 段（模块 SKILL.md 的跨端 / 上下游关联表）
// ---------------------------------------------------------------------------

/** 模块 `SKILL.md` 里「§关联模块」表的固定列 —— **列名列序都不许改**（插件按它回填）。 */
export const LINK_TABLE_COLUMNS = ['关联模块', '方向', '关联类型', '业务对象', '交接点', '共享表', '对端路由', '说明']

/** 认「§关联模块」段头（`## §关联模块（跨端 / 上下游）` 这类都算）。 */
const LINK_SECTION_RE = /^\s*##\s*§关联模块/
/** 表格定位签名词：这 3 个词只可能同时出现在关联表上（别的表都不含「关联模块」）。 */
const LINK_TABLE_SIGNATURE = ['关联模块', '方向', '关联类型']
/** 新段的口径说明（没这段的老 `SKILL.md` 补段时用）。 */
const LINK_SECTION_NOTE = [
  '> 口径：本模块与其它模块有业务关联时，**两端必须都能查到**；**单一事实源**在产品级',
  '> `_框架配置\\模块关联.md`，这里只写**本端视角**。**没有关联就写「暂无」。**',
]

/** 在一段行里找「表头含全部签名词、紧跟分隔行」的表头行号；找不到返回 -1。 */
function findTableHeader(lines, from, to, signature) {
  for (let i = from; i < to; i += 1) {
    const line = lines[i] ?? ''
    if (!line.trim().startsWith('|')) continue
    if (!signature.every((term) => line.includes(term))) continue
    if (!DELIMITER_ROW.test(lines[i + 1] ?? '')) continue
    return i
  }
  return -1
}

/** 把一行行 cells 拼成 markdown 表格行。 */
function tableRow(cells) {
  return `| ${cells.map((c) => String(c ?? '').trim()).join(' | ')} |`
}

/**
 * 往模块 `SKILL.md` 里 upsert「§关联模块」段 —— **只追加 / 段内 upsert，绝不覆盖别的内容**。
 *
 * 三种情况：
 *   ① 已有该段且有这张表 → 段内逐行 upsert（同「关联模块」列就地替换，保证反复登记不堆行）；
 *   ② 已有该段但表没了 → 在段头之后补一张表（不动段里的其它文字）；
 *   ③ **没有该段** → 新起一段：优先插在 `## 归档索引` **之前**（归档索引永远该是最后一段）；
 *      插不进去（归档段就在第 1 行）就追加到文件最末，并在 `warning` 里说清。
 *
 * @returns {{ ok: boolean, md: string, action: string, warning?: string }}
 */
export function upsertLinkSection(md, rows, options = {}) {
  const columns = options.columns ?? LINK_TABLE_COLUMNS
  const title = options.title ?? '§关联模块（跨端 / 上下游）'
  const src = String(md ?? '')
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, md: src, action: 'no-rows' }
  const header = tableRow(columns)
  const delimiter = tableRow(columns.map(() => '---'))
  const lines = src.split(/\r?\n/)

  const headerIdx = lines.findIndex((l) => LINK_SECTION_RE.test(l))
  if (headerIdx >= 0) {
    let end = headerIdx + 1
    while (end < lines.length && !/^\s*##\s/.test(lines[end])) end += 1
    const slice = lines.slice(headerIdx, end)
    if (findTableHeader(slice, 1, slice.length, LINK_TABLE_SIGNATURE) < 0) {
      slice.splice(1, 0, '', header, delimiter)
    }
    let sectionMd = slice.join('\n')
    const before = sectionMd
    for (const cells of rows) {
      const r = upsertTableRow(sectionMd, LINK_TABLE_SIGNATURE, 0, cells)
      if (r.ok) sectionMd = r.md
    }
    const next = [...lines.slice(0, headerIdx), ...sectionMd.split(/\r?\n/), ...lines.slice(end)]
    return { ok: true, md: next.join('\n'), action: sectionMd === before ? 'section-unchanged' : 'section-upsert' }
  }

  const section = [
    `## ${title}`,
    '',
    ...LINK_SECTION_NOTE,
    '',
    header,
    delimiter,
    ...rows.map(tableRow),
    '',
  ].join('\n')
  const archiveIdx = lines.findIndex((l) => /^\s*##\s*归档索引/.test(l))
  if (archiveIdx > 0) {
    const beforeText = lines.slice(0, archiveIdx).join('\n').replace(/\s+$/, '')
    const afterText = lines.slice(archiveIdx).join('\n')
    return { ok: true, md: `${beforeText}\n\n---\n\n${section}\n---\n\n${afterText}`, action: 'insert-before-archive' }
  }
  const base = src.replace(/\s+$/, '')
  const appended = `${base}\n\n---\n\n${section}`
  return archiveIdx === 0
    ? {
      ok: true,
      md: appended,
      action: 'append-end',
      warning: '文件以「## 归档索引」开头，没法把新段插在它之前 —— 已追加到文件最末。',
    }
    : { ok: true, md: appended, action: 'append-end' }
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
 * 新增一个模块：建目录 → 生成 `SKILL.md`（按模块骨架模板渲染）→ 回填两处路由表 →
 * 写「§关联模块」段 → 更新登记（含 `end` / `businessObjects` / `relations[]`）。
 *
 * **模块 `SKILL.md` 已存在时永不覆盖**（它是累积型文档，见框架铁律）。
 *
 * 三个 0.3.0 新增的可选入参（新口径：**模块 = 叶子菜单**，每个模块带「端」与「逻辑业务对象」）：
 *   · `end`：这个模块属于哪个端（中心端 / 成员端 / 患者端 …）。缺省取 `ends[]` 里 `default: true` 的那个；
 *   · `businessObjects`：逻辑业务对象（字符串 / 数组 / 逗号分隔都行）。跨端对齐靠它；
 *   · `links`：跨端/上下游关联边。元素可以是**模块名字符串**（归一成 `{ to, kind: '关联' }`），
 *     也可以是 `{ to, kind, businessObject, handoff, sharedTables, routes, nameVariance, accounts, evidence, status }`。
 *     以 `(from,to,businessObject,flow)` 为键**幂等 upsert**；`from` 登记时只写 `from → to` 一条，
 *     反向那条由对方模块自己登记（两边的 `registeredOnBothSides` 会自动标成 `true`）。
 */
export function addModule(options) {
  const root = path.resolve(options.root ?? process.cwd())
  const product = String(options.product ?? '').trim()
  const module = String(options.module ?? '').trim()
  if (!product) throw new Error('addModule 需要 product')
  if (!module) throw new Error('addModule 需要 module')
  const dryRun = options.dryRun === true
  const pluginVersion = options.pluginVersion ?? 'unknown'
  let menu = options.menu ?? '（待补）'
  let menuPath = options.menuPath ?? menu
  let route = options.route ?? '（待补）'
  let doc = options.doc ?? ''
  let version = options.version ?? ''
  const slugInput = String(options.slug ?? '').trim() || slugify(module)
  const slug = slugInput || `mod-${Math.abs(hash32(module)).toString(36)}`
  const result = {
    created: [],
    skipped: [],
    warnings: [],
    slug,
    skillPath: undefined,
    versionSkillPath: undefined,
    end: '',
    businessObjects: [],
    relations: [],
  }

  if (!slugInput) {
    result.warnings.push(
      `模块名「${module}」是纯中文，自动兜底的 slug 是 \`${slug}\`（不好看也不好记）。`
      + '建议重跑并显式传 slug（拼音，如 缺药登记 → queyao-dengji）。',
    )
  }

  // ---- 端 / 业务对象：解析（要读登记才知道默认端叫什么）----
  const pre = dryRun ? readRegistry(root, product) : ensureRegistry(root, product, { pluginVersion })
  const registry = pre.registry ?? emptyRegistry({ product, frameworkRoot: root, pluginVersion })
  const { list: endList, defaultName } = endsOf(registry)
  // 重复登记（典型场景：**在对方模块补登记反向关联边**）时，**不许把上次记下的字段抹成「（待补）」** ——
  // 本次没显式给的，沿用登记里已有的值；否则补一条关联边就会悄悄清掉路由 / 菜单 / 文档 / 版本。
  const prevMod = (Array.isArray(registry.modules) ? registry.modules : []).find((m) => asText(m?.name) === module)
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  const keepText = (next, old) => (given(next) ? asText(next) : (given(old) ? asText(old) : asText(next)))
  menu = keepText(options.menu, prevMod?.menu) || '（待补）'
  menuPath = keepText(options.menuPath, prevMod?.menuPath) || menu
  route = keepText(options.route, prevMod?.route) || '（待补）'
  doc = keepText(options.doc, prevMod?.doc)
  version = keepText(options.version, prevMod?.version)
  const end = keepText(options.end, prevMod?.end) || defaultName
  const givenBusinessObjects = normalizeBusinessObjects(options.businessObjects)
  const businessObjects = givenBusinessObjects.length
    ? givenBusinessObjects
    : asTextArray(prevMod?.businessObjects)
  const links = normalizeLinks(options.links)
  result.end = end
  result.businessObjects = businessObjects

  // ---- 命名规则校验（违反只记 warnings，**不阻断**）----
  const nonDefault = isNonDefaultEnd(registry, end)
  if (nonDefault) {
    if (!module.startsWith(`${end}-`)) {
      result.warnings.push(
        `模块名「${module}」声明了非默认端「${end}」，但没带端前缀 —— 命名规则是`
        + `「${end}-<逻辑业务对象>」（如 \`${end}-缺药登记\`）。模块目录名会与登记/路由对不上。`,
      )
    }
    if (businessObjects.length === 0) {
      result.warnings.push(
        `模块「${module}」是非默认端（${end}），但没给 \`businessObjects\` —— `
        + '跨端对齐（哪几个模块是同一个业务）就没了判据。',
      )
    }
  } else if (end !== '') {
    const hit = endList.find((e) => module.startsWith(`${e.name}-`))
    if (hit) {
      result.warnings.push(
        `模块名「${module}」属于默认端「${end}」，不该带端前缀「${hit.name}-」—— 默认端的模块名不带前缀。`,
      )
    }
  } else if (endList.length > 0) {
    result.warnings.push(
      `没给 \`end\`，且 \`ends[]\` 里没有 \`default: true\` 的端 —— 按默认端处理（模块名不该带端前缀）。`,
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

  // ---- 关联边（跨端 / 上下游）：以 (from,to,businessObject,flow) 为键幂等 upsert ----
  const linkResult = applyModuleLinks(registry, { module, businessObjects, links })
  result.warnings.push(...linkResult.warnings)
  result.relations = linkResult.rows.map((r) => r.relation)
  const relationRows = linkResult.rows

  // ---- 往模块 SKILL.md 追加 / upsert「§关联模块」段（**只追加，绝不覆盖**）----
  if (relationRows.length > 0) {
    const indexMdForLinks = readText(skillAbs)
    if (indexMdForLinks === undefined) {
      // dryRun 时 SKILL.md 还没落盘：只报计划，不算异常
      if (dryRun) result.created.push(`${skillRel} §关联模块（计划：${relationRows.length} 条）`)
      else result.warnings.push(`${skillRel} 读不到 —— §关联模块没回填，请手工加一行`)
    } else {
      const merged = upsertLinkSection(indexMdForLinks, relationRows.map((r) => r.cells))
      if (merged.warning) result.warnings.push(`${skillRel}：${merged.warning}`)
      if (!merged.ok) {
        result.warnings.push(`${skillRel} 里没找到 §关联模块 表 —— 关联行没写进去，请手工补`)
      } else if (!dryRun && merged.md !== indexMdForLinks) {
        fs.writeFileSync(skillAbs, merged.md, 'utf8')
      }
      if (merged.ok && merged.md !== indexMdForLinks) {
        result.created.push(`${skillRel} §关联模块（${relationRows.length} 条）`)
      } else {
        result.skipped.push(`${skillRel} §关联模块（已是最新）`)
      }
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
    const { registry: fresh } = ensureRegistry(root, product, { pluginVersion })
    const mods = Array.isArray(fresh.modules) ? [...fresh.modules] : []
    const idx = mods.findIndex((m) => m?.name === module)
    const entry = {
      name: module,
      end,
      businessObjects,
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
    fresh.modules = mods
    // 关联边再幂等应用一次（上面那次是为了拿表行；警告已收过，这里静默重放）
    applyModuleLinks(fresh, { module, businessObjects, links })
    fresh.gates = recomputeGates(fresh)
    writeRegistry(root, product, fresh)
  }

  return result
}

/** markdown 单元格消毒：`|` 会截断表格、换行会拆行。 */
function cell(value) {
  return String(value ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim()
}

/**
 * 把 `links` 幂等写进 `registry.relations`（**纯计算，不落盘**）。
 *
 * 幂等键 = `(from, to, businessObject, flow)`（见 `relationKey`）：同键就地更新，绝不堆重复行。
 * `businessObject` 没给就取本模块 `businessObjects[0]`（跨端对齐靠它，别让它空着）。
 *
 * **写出去的字段名以产品登记的规范口径为准**（`tables` / `fromRoute` / `toRoute` / `note` …，
 * 见 `templates\产品\_框架配置\模块关联.md`），同时**保留插件原名作为兼容别名**
 * （`sharedTables` / `routes{from,to}` / `nameVariance`+`evidence`+`status`）——
 * 两套都写，产品侧脚本与插件读哪套都能读到。规范名的值**为空时不写这个键**（不留空壳字段）。
 * 其中 **`note` 例外地"只在显式给出时才写"**：它是人写的自由文本，机器拼接的散文会被误当成已确认口径
 * （缺位时的兜底串只渲染进模块 `SKILL.md`，带 `[自动]` 前缀，不进 JSON）。
 *
 * **双向登记**：只写 `from → to` 一条；但每次都会重算所有边的 `registeredOnBothSides`
 * —— 对方模块也登记了反向边时，两条都变成 `true`（顺序无关，谁先谁后都收敛）。
 *
 * ⚠️ **幂等更新不许毁掉已有数据**：同键已存在时，**本次没显式给的字段一律沿用旧值** ——
 * 否则"只补一句 `links`"就会把对方手写的 `note` / 散文形态的 `fromRoute` 覆盖掉，
 * 还会把 `status: 已确认` 降级成默认的 `待核`（与模块侧那个真机上踩到的缺陷同一类）。
 */
function applyModuleLinks(registry, { module, businessObjects = [], links = [] }) {
  const reg = registry
  const relations = Array.isArray(reg.relations) ? [...reg.relations] : []
  const known = new Set((Array.isArray(reg.modules) ? reg.modules : []).map((m) => asText(m?.name)))
  known.add(module)
  const warnings = []
  const rows = []
  /** 本次给了就用本次的，没给就沿用旧值（旧值也没有 → 空串）。 */
  const keep = (next, old) => (asText(next) !== '' ? asText(next) : asText(old))
  const keepList = (next, old) => (asTextArray(next).length ? asTextArray(next) : asTextArray(old))
  for (const link of links) {
    const boKey = asText(link.businessObject) || businessObjects[0] || ''
    const flowGiven = asText(link.flow)
    // 先按精确键找；本次没给 `flow` 时再放宽到 (from,to,业务对象) 找一次 ——
    // 这样"只补一句话"也能命中已有的那条边、沿用它的 flow，而不是又堆一条重复边。
    const old = relations.find((r) => relationKey(r) === relationKey({ from: module, to: link.to, businessObject: boKey, flow: flowGiven }))
      ?? (flowGiven === ''
        ? relations.find((r) => asText(r.from) === module && asText(r.to) === link.to && sameWildcard(r.businessObject, boKey))
        : undefined)
    const businessObject = boKey || asText(old?.businessObject)
    const flow = asText(link.flow) || asText(old?.flow)
    const kind = keep(link.kind, old?.kind) || '关联'
    const handoff = keep(link.handoff, old?.handoff)
    const status = keep(link.status, old?.status) || '待核'
    const nameVariance = keep(link.nameVariance, old?.nameVariance)
    const evidence = keep(link.evidence, old?.evidence)
    const accounts = keepList(link.accounts, old?.accounts)
    // 路由 / 共享表：规范名的**原文**优先（可能是手写的散文形态，原样留着）
    const fromRoute = keep(link.fromRouteRaw || link.routes?.from, old?.fromRoute || old?.routes?.from)
    const toRoute = keep(link.toRouteRaw || link.routes?.to, old?.toRoute || old?.routes?.to)
    const tablesRaw = keep(link.tablesRaw, old?.tables)
    let sharedTables = keepList(link.sharedTables, old?.sharedTables)
    if (!sharedTables.length && tablesRaw) sharedTables = splitTables(tablesRaw)
    const tables = tablesRaw || (sharedTables.length ? sharedTables.map((t) => `\`${t}\``).join('<br>') : '')
    // `note` 是**人写的自由文本**（单一事实源里的散文）：**只在调用方显式给了才落键**，
    // 绝不拿 `nameVariance/evidence/status` 拼一个塞进 JSON —— 机器拼出来的散文会被后续会话
    // 误当成"人确认过的口径"。缺位时的兜底串**只在渲染模块 SKILL.md 那一列时**临时拼（带 `[自动]` 前缀）。
    const note = keep(link.noteRaw, old?.note)
    const relation = {
      id: asText(link.id) || asText(old?.id) || relationId(module, link.to, businessObject),
      from: module,
      to: link.to,
      businessObject,
      kind,
      handoff,
      // ---- 规范名（产品登记口径，写这套；空值不写键）----
      ...(tables ? { tables } : {}),
      ...(fromRoute ? { fromRoute } : {}),
      ...(toRoute ? { toRoute } : {}),
      ...(note ? { note } : {}),
      // ---- 插件原名的兼容别名（同一份值，读哪套都行）----
      sharedTables,
      routes: { ...(fromRoute ? { from: fromRoute } : {}), ...(toRoute ? { to: toRoute } : {}) },
      nameVariance,
      accounts,
      evidence,
      status,
    }
    if (flow !== '') relation.flow = flow
    const key = relationKey(relation)
    const idx = relations.findIndex((r) => relationKey(r) === key)
    if (idx >= 0) relations[idx] = { ...relations[idx], ...relation }
    else relations.push(relation)
    if (!known.has(link.to)) {
      warnings.push(
        `关联边指向的模块「${link.to}」还没登记在 \`${REGISTRY_FILE}\` 的 \`modules[]\` 里 —— `
        + '已先记下这条边；对方模块登记后，两条边会自动补成双向。',
      )
    }
    // 说明列：以人写的 `note` 为准；**note 缺位时**才现拼一个带 `[自动]` 前缀的兜底串 ——
    // 前缀就是它的身份声明（机器拼的，不是人确认过的口径），且**只出现在 markdown 里，不进 JSON**。
    const autoNote = [
      nameVariance,
      evidence ? `依据：${evidence}` : '',
      status && status !== '已确认' ? `状态：${status}` : '',
    ].filter(Boolean).join('；')
    const noteCell = note || (autoNote ? `[自动] ${autoNote}` : '')
    rows.push({
      relation,
      cells: [
        cell(link.to),
        cell(`${module} → ${link.to}`),
        cell(relation.kind),
        cell(businessObject || '（未写）'),
        cell(relation.handoff || '——'),
        cell(sharedTables.length ? sharedTables.join('<br>') : '——'),
        cell(toRoute || fromRoute || '——'),
        cell(noteCell || '——'),
      ],
    })
  }
  // 双向标记：全部边一起重算（顺序无关，反复登记收敛到同一个结果）
  for (const r of relations) {
    r.registeredOnBothSides = relations.some((q) => q !== r
      && asText(q.from) === asText(r.to) && asText(q.to) === asText(r.from)
      && sameWildcard(q.businessObject, r.businessObject)
      && sameWildcard(q.flow, r.flow))
  }
  reg.relations = relations
  return { registry: reg, rows, warnings }
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
    // 提示词预算 —— `AGENTS.md` 越写越长会把 DSH 的 65536 字节基线上限撑爆，
    // 超了它会**先丢宽范围文件、再截断本文件尾部**，也就是契约被**静默**砍掉一截
    // （2026-10-22 本框架真发生过：65494 → 65143）。所以这里每次都量一遍。
    // 传 `skipBudget: true` 可跳过（测试用，避免断言依赖跑测机器的 DSH_HOME）。
    promptBudget: (options.skipBudget || !found)
      ? null
      : (() => {
        try {
          return checkPromptBudget({ root: found.root, dshHome: options.dshHome })
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
  // 提示词预算：正常时是空串（不占提示词），只有「告急 / 已超」才说 —— 因为超预算的后果是
  // `AGENTS.md` 被截断，而这**不会报错**，只能靠这里主动提。
  const budget = status.promptBudget?.level === BUDGET_OK ? '' : renderBudgetBlock(status.promptBudget)
  if (pending.length === 0 && status.agentsMdAutoLoaded && !prereq && !isolation && !budget) return ''
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
  if (budget) {
    lines.push('')
    lines.push(budget)
  }
  return lines.join('\n')
}

export { TEMPLATE_ROOT }
