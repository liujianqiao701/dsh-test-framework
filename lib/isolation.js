/**
 * 防干扰（隔离）检查 —— 让「**别的项目 / 别的框架在影响本框架**」在每个会话开头就看得见。
 *
 * 为什么需要它：框架根 `AGENTS.md` §零 定的是「本框架是唯一权威」，但光有规矩**不会自动生效** ——
 * 真实事故是：本机**另一套工具链的工作区**（自带**另一份完整 AGENTS.md** 和 `.trae` 规范库）
 * 的"落盘必须在工作区内"这条规矩渗进了本框架，模块里被建出一批**永远装不进东西**的 `temps\_P1_temps\`
 * 空壳，模块 `SKILL.md` 里还留下"照着做必然失败"的经验。根因是**没有裁决规则**，迁就外部成了默认。
 *
 * 本模块负责**把干扰探测出来**，而不是再写一遍规矩：
 *   ① 契约来源 —— 当前会话的项目根到底是谁？（DSH 只认 `.git`）本框架契约到底加载了没有？
 *   ② 嵌套仓库 —— 框架树内部有自己的 `.git` 时，项目根会被**截断**到那儿，本框架契约**静默不加载**
 *      （典型：`_plugin\dsh-test-framework\`，插件源码自带 git 仓库）。
 *   ③ 别家契约 —— 项目根解析到了框架**外面**时，实际生效的是**别人的** `AGENTS.md`。
 *   ④ 落点污染 —— 模块里出现 `temps\` / `outputs\` / `node_modules\` / `.trae\` 这类**外部工具的工作目录**
 *      （目录会被后来者当成"这里的约定"照着建，`temps\` 就是这么复制开来的 —— 所以**目录算污染，散落文件不算**）。
 *   ⑤ 关键标记 —— `.git` 与 `.dsh\skills`（DSH 的 skill 发现入口）在不在、指向对不对。
 *
 * 设计纪律（与 `prereq.js` 一致）：
 * - **零第三方依赖**，只用 node 内置模块。
 * - **没发现问题就返回 `''`** —— 每次会话都刷一段"一切正常"是纯噪音。
 * - **措辞**：静态推测，一律说"**未检测到**"，不说"不存在"；拿不准就写"无法判定"。
 * - **不越界**：只**报告**，不改别人的文件、不碰框架内容。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 模块一级允许项 —— 与框架 `AGENTS.md` §一 的模块结构一致。 */
const MODULE_DIRS = new Set(['requirement', 'final', 'report', 'data', 'skill', 'scripts'])
const MODULE_FILES = new Set(['SKILL.md'])

/**
 * 模块里**不该出现**的一级目录名（小写比较）。
 *
 * 前几个是**外部工具的工作目录**（kw / cr69 那套的 `temps\_P{N}_temps\`、`outputs`、
 * 抓包落盘的 `html` / `images` / `dom`），后面几个是通用垃圾。
 */
const FOREIGN_DIR_NAMES = new Set([
  'temps', '_p1_temps', '_p2_temps', 'outputs', 'node_modules', '.trae',
  'html', 'images', 'dom', '__pycache__', 'dist', 'build', 'logs',
])

/** 从 `start` 向上找第一个含 `.git` 的目录（DSH 判定"项目根"的方式）。 */
export function findGitRoot(start) {
  let cur = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 是不是"框架树内部的目录"（框架根自己也算）。 */
function isInside(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(p + path.sep)
}

/**
 * 框架根下**不是产品**的目录。
 *
 * 命名规则（`AGENTS.md` §一）说"`_` 开头的是辅助目录"，但 `skills\` 是**历史命名、没有下划线**
 * —— 只按下划线判断会把它当成一个"产品"，再把 `skills\vision-read\` 当成模块，
 * 于是 `engine\`（千问桥，正当内容）被误报成"外来目录"。所以这里显式排除。
 * ⚠️ 与框架级 skill `framework-guard` 的 `check_isolation.py` 保持同一口径。
 */
const NON_PRODUCT_DIRS = new Set([
  'skills', 'node_modules', 'dist', 'build', 'out', 'tmp', 'temp',
  'test', 'tests', 'docs', 'lib', 'src', 'assets', 'public',
])

/** 框架根下一级的产品目录（辅助目录既看下划线命名，也看上面的显式排除表）。 */
function listProducts(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory()
        && !e.name.startsWith('_') && !e.name.startsWith('.')
        && !NON_PRODUCT_DIRS.has(e.name.toLowerCase()))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 产品下的一级模块目录。 */
function listModules(productDir) {
  try {
    return fs.readdirSync(productDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 只做一级扫描，避免把 `skills\vision-read\engine\node_modules\` 这类正常嵌套当成污染。 */
function scanModulesForForeignDirs(root) {
  const hits = []
  for (const product of listProducts(root)) {
    const productDir = path.join(root, product)
    for (const module of listModules(productDir)) {
      const moduleDir = path.join(productDir, module)
      let entries
      try {
        entries = fs.readdirSync(moduleDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const rel = path.join(product, module, e.name)
        if (e.isDirectory()) {
          if (FOREIGN_DIR_NAMES.has(e.name.toLowerCase()) || !MODULE_DIRS.has(e.name)) {
            hits.push({ kind: 'dir', name: e.name, rel, dir: path.join(moduleDir, e.name) })
          }
        } else if (!MODULE_FILES.has(e.name)) {
          // 散落**文件**只算"没归位"，不算污染 —— 可能是有意的生成落点
          // （例：某模块的 docx 构建脚本把产物写在模块根）。单列出来，别吓人。
          hits.push({ kind: 'file', name: e.name, rel, dir: moduleDir })
        }
      }
    }
  }
  return {
    dirs: hits.filter((h) => h.kind === 'dir'),
    files: hits.filter((h) => h.kind === 'file'),
  }
}

/** 契约来源判定：当前会话到底会加载哪份 `AGENTS.md`。 */
function resolveContract({ root, projectRoot, cwd }) {
  const start = path.resolve(cwd)
  const gitRoot = projectRoot ? path.resolve(projectRoot) : findGitRoot(start)
  // ⚠️ DSH 向上找不到 `.git` 时会**退回 cwd 当项目根**（框架 AGENTS.md §一 ⚠️ 写的就是这个）。
  // 这个"退回"本身就是最常见的干扰形态：别家工作区**没有 .git**，
  // 于是它自己的 `AGENTS.md` 反而被当成"本会话的契约"加载了 —— 必须能报出来。
  const resolved = gitRoot ?? start
  const viaGit = Boolean(gitRoot)
  const agents = path.join(resolved, 'AGENTS.md')
  const info = {
    cwd: start,
    frameworkRoot: path.resolve(root),
    resolvedRoot: resolved,
    /** 项目根是靠 `.git` 定出来的，还是靠"退回 cwd"（`false` 时更要留神） */
    viaGit,
    agentsFile: agents,
    agentsExists: fs.existsSync(agents),
    /** 项目根就是框架根 ⇒ 本框架契约会被自动加载 */
    loaded: path.resolve(resolved) === path.resolve(root),
    /** 项目根在框架树**内部**但不是框架根 ⇒ 被嵌套仓库截断了 */
    truncatedBy: null,
    /** 项目根在框架树**外面** ⇒ 生效的是别人的契约 */
    foreignRoot: null,
  }
  if (!info.loaded) {
    if (isInside(resolved, root)) {
      // 退回 cwd 导致的不算"嵌套仓库截断" —— 那种情况由 `no-git` 那条说（措辞不同，别混）
      if (viaGit) info.truncatedBy = resolved
    } else {
      info.foreignRoot = resolved
    }
  }
  return info
}

/** 两个关键标记：`.git`（项目根识别）与 `.dsh\skills`（skill 发现入口）。 */
function checkMarkers(root) {
  const git = path.join(root, '.git')
  const link = path.join(root, '.dsh', 'skills')
  const want = path.join(root, 'skills')
  let linkTarget = null
  let linkOk = false
  if (fs.existsSync(link)) {
    try {
      linkTarget = fs.realpathSync(link)
      linkOk = linkTarget === fs.realpathSync(want)
    } catch {
      linkTarget = null
    }
  }
  return { git: fs.existsSync(git), skillsLink: fs.existsSync(link), linkTarget, linkOk }
}

/**
 * 周边有哪些**别家的**契约 / 规范库 —— 只报告，不评判。
 *
 * 为什么只报告、不进闸门：这些东西**存在是正常的**（这台机器上就有别的项目），
 * 每天都刷一遍"检测到 6 个外部权威"是纯噪音。**只有当会话真的加载了它们**（项目根解析到那儿）
 * 才算问题 —— 那由 `checkIsolation` 的 `contract-foreign` 负责。
 *
 * 判据：框架根**所在盘的兄弟目录**（一层）+ **祖先目录**（祖先优先级更高，会盖过本框架）+ 用户级。
 */
export function scanExternalAuthorities(root) {
  const found = []
  const self = path.resolve(root)
  const parent = path.dirname(self)

  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = path.join(parent, e.name)
      if (path.resolve(dir) === self) continue
      const agents = path.join(dir, 'AGENTS.md')
      if (fs.existsSync(agents)) found.push({ kind: 'contract', label: '另一份完整契约', path: agents })
      const trae = path.join(dir, '.trae')
      if (fs.existsSync(trae)) found.push({ kind: 'specs', label: '另一套规范库（外部工具从这里取规范）', path: trae })
    }
  } catch {
    // 盘根读不了就算了 —— 静态推测，不因此下任何结论
  }

  for (let p = parent; ; p = path.dirname(p)) {
    const agents = path.join(p, 'AGENTS.md')
    if (fs.existsSync(agents)) found.push({ kind: 'ancestor', label: '**祖先目录**的契约（优先级更高，会盖过本框架）', path: agents })
    if (path.dirname(p) === p) break
  }

  const home = os.homedir()
  for (const f of [path.join(home, 'AGENTS.md'), path.join(home, '.dsh', 'AGENTS.md')]) {
    if (fs.existsSync(f)) found.push({ kind: 'user', label: '用户级（对所有会话生效）', path: f })
  }

  return found
}

/**
 * 本框架**真有**的依据来源 —— 用来决定引用哪几处。
 *
 * 为什么要探测而不是写死：本插件是**通用的**，会给别人的框架用。
 * 如果一个框架的 `AGENTS.md` 里没有 §零、也没有 `framework-guard` skill，
 * 却告诉对方"依据 §零" —— 那是指向不存在的文件，比不引用更糟。
 */
function detectCitations(root) {
  const out = []
  try {
    if (/^##\s*零、/m.test(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))) {
      out.push('框架根 `AGENTS.md` **§零**（权威、边界与冲突裁决）')
    }
  } catch {
    // 读不到 AGENTS.md 就不引用它
  }
  if (fs.existsSync(path.join(root, 'skills', 'framework-guard', 'SKILL.md'))) {
    out.push('框架级 skill `framework-guard`')
  }
  return out
}

/**
 * 跑一遍防干扰检查。
 *
 * @param {{root: string, projectRoot?: string|null, cwd?: string}} opts
 * @returns {{contract: object, markers: object, stray: object, externals: Array<object>, citations: Array<string>, items: Array<object>}}
 */
export function checkIsolation({ root, projectRoot = null, cwd = process.cwd() } = {}) {
  const items = []
  if (!root || !fs.existsSync(root)) {
    return { contract: null, markers: null, stray: { dirs: [], files: [] }, externals: [], citations: [], items }
  }

  const contract = resolveContract({ root, projectRoot, cwd })
  const markers = checkMarkers(root)
  const stray = scanModulesForForeignDirs(root)
  const externals = scanExternalAuthorities(root)
  const citations = detectCitations(root)

  if (!markers.git) {
    items.push({
      key: 'no-git',
      level: 'warn',
      title: '框架根没有 `.git` 标记 —— 契约可能不自动加载',
      detail: 'DSH 只认 `.git` 作为"项目根"标记；缺了它，只有 cwd 恰好是框架根时才会加载根 `AGENTS.md`，'
        + '在模块子目录里开会话会**静默不加载**。`.git` 只是根标记、不用来管版本，别删。',
      fix: '`test_framework_init` 会补上（或手工 `git init` 一个空库当标记）。',
    })
  }

  if (contract.truncatedBy) {
    items.push({
      key: 'contract-truncated',
      level: 'warn',
      title: `项目根被**嵌套仓库**截断到 \`${contract.truncatedBy}\` —— 本框架契约不会加载`,
      detail: `当前会话目录：\`${contract.cwd}\`\n`
        + `  · 解析到的项目根：\`${contract.resolvedRoot}\`（这里有自己的 \`.git\`）\n`
        + `  · 会加载的契约：${contract.agentsExists ? `\`${contract.agentsFile}\`` : '**该根下没有 AGENTS.md**'}\n`
        + `  · 本框架框架根：\`${contract.frameworkRoot}\``,
      fix: '在这种目录（典型：`_plugin\\dsh-test-framework\\`，插件源码自带 git 仓库）里干活前，'
        + '**先手动读框架根 `AGENTS.md`** —— 别以为它会自动加载。',
    })
  }

  if (contract.foreignRoot) {
    items.push({
      key: 'contract-foreign',
      level: 'warn',
      title: `当前会话的项目根在框架**外面**（\`${contract.foreignRoot}\`）`,
      detail: (contract.viaGit
        ? `会生效的是**那个目录的** \`AGENTS.md\``
        : '向上找不到 `.git`，DSH 退回了 **cwd 当项目根**，于是那里的 `AGENTS.md` 会被当成"本会话的契约"加载')
        + `${contract.agentsExists ? `（\`${contract.agentsFile}\`）` : '（该目录下未检测到 AGENTS.md）'}；`
        + `\n  本框架契约（\`${path.join(contract.frameworkRoot, 'AGENTS.md')}\`）**对本会话没有约束力**。`,
      fix: '如果这本来就是别的项目，属正常。若你本意是在**本框架**里干活，'
        + `请把会话目录放到 \`${contract.frameworkRoot}\` 或其子目录。`,
    })
  }

  if (!stray.dirs.length && !markers.git && !contract.loaded) {
    // 契约就没加载，落点扫描没意义（扫的可能根本不是本框架的活儿）
  }

  if (stray.dirs.length) {
    const list = stray.dirs.slice(0, 8).map((h) => `  · \`${h.rel}\``).join('\n')
    items.push({
      key: 'stray-dirs',
      level: 'warn',
      title: `模块里出现**不该有的目录** ${stray.dirs.length} 个 —— 疑似别的工具的工作目录`,
      detail: `${list}${stray.dirs.length > 8 ? `\n  · …还有 ${stray.dirs.length - 8} 个` : ''}\n`
        + '  模块一级只允许：`requirement/` `final/` `report/` `data/` `skill/` `scripts/` + `SKILL.md`。',
      fix: '**外部工具要路径时，落它自己的工作区、再把要留的证据拷回模块 `data\\`** —— '
        + '不许为了迁就外部工具在框架里新建目录。'
        + '目录会被后来者当成"这里的约定"继续用，`temps\\` 就是这么复制开来的。',
    })
  }

  return { contract, markers, stray, externals, citations, items }
}

/** 有没有**需要拦一下**的发现（`file` 类散落文件不算）。 */
export function hasActionable(result) {
  return Boolean(result && result.items.some((i) => i.level === 'warn'))
}

/**
 * 渲染防干扰提示（Markdown）—— **只报"需要拦一下"的**。
 *
 * **没问题就返回 `''`**（不占 token），有发现时说清"哪来的干扰 + 现在生效的是哪份规矩 + 该怎么办"。
 *
 * ⚠️ 散落**文件**（未归位）**故意不在这里报** —— 它可能是有意的生成落点（本框架自己就有一个：
 * 模块根的 docx 是构建脚本的产物、还有核对脚本回头读它），每次会话刷一句就是噪音。
 * 文件的情况在 `renderIsolationStatus` 里**只计数**，人主动看时才展开。
 */
export function renderIsolationBlock(result) {
  if (!result || !result.items.length) return ''
  const lines = []
  for (const item of result.items) {
    lines.push(`⚠️ **防干扰：${item.title}**`)
    if (item.detail) lines.push(item.detail.split('\n').map((l) => (l.startsWith('  ') ? l : `  ${l}`)).join('\n'))
    if (item.fix) lines.push(`  → ${item.fix}`)
  }
  if (result.citations?.length) {
    lines.push(`  · 依据：${result.citations.join(' + ')}。`)
  }
  return lines.join('\n')
}

/**
 * 状态 / 体检用的**完整**画面 —— 含「周边有哪些外部权威」这类信息性内容。
 *
 * 与 `renderIsolationBlock` 的分工：**闸门那边没发现就闭嘴**（免得每会话刷噪音），
 * 这里**永远有输出**（因为是人主动要看）。
 */
export function renderIsolationStatus(result) {
  if (!result) return ''
  const lines = []
  const c = result.contract
  if (c) {
    lines.push(`- 项目根（决定加载哪份 \`AGENTS.md\`）：\`${c.resolvedRoot}\``
      + (c.viaGit ? '' : ' —— ⚠️ **向上找不到 `.git`，DSH 退回了 cwd 当项目根**'))
    lines.push(`- 本框架契约是否生效：**${c.loaded ? '是' : '否'}**`
      + (c.agentsExists ? `（会加载 \`${c.agentsFile}\`）` : '（该根下未检测到 AGENTS.md）'))
  }
  if (result.externals.length) {
    lines.push(`- 周边检测到 **${result.externals.length}** 个**外部**权威来源 —— **都不是本框架**，`
      + '只在其自身范围内有效（框架根 `AGENTS.md` §零）：')
    for (const e of result.externals.slice(0, 10)) lines.push(`  - \`${e.path}\` —— ${e.label}`)
    if (result.externals.length > 10) lines.push(`  - …还有 ${result.externals.length - 10} 个`)
  } else {
    lines.push('- 周边未检测到外部契约 / 规范库')
  }
  lines.push(`- 模块落点：${result.stray.dirs.length ? `⚠️ **${result.stray.dirs.length}** 个不该有的目录` : '✅ 未发现外来目录'}`
    + (result.stray.files.length ? `；另有 ${result.stray.files.length} 个散落文件（未归位，不算污染）` : ''))
  return lines.join('\n')
}
