/**
 * 模型可见工具的定义。
 *
 * ⚠️ **刻意不用 `defineTool()`**：它是 `@deepseek-ai/dsh-tools` 的导出，而本插件是
 * `link:` 安装的（真实路径在 profile 之外），Node 解析不到 profile 的 `node_modules\@deepseek-ai\*`。
 * 所以这里**手写等价形状**：`{ name, description, parameters, output: { schema, render }, execute }`。
 * `ToolRuntime.register()` 只强制校验 `output.schema`（受支持 JSON Schema）+ `output.render`（函数），
 * 原始注册的工具自己负责输入校验 —— 我们每个工具都在 `execute` 里做参数校验并抛中文错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  frameworkStatus,
  renderGate,
  scaffold,
  addModule,
  checkLinks,
  recordEnvironments,
  recordDocuments,
  listProducts,
  readText,
  isFile,
  missingItems,
  ensureRegistry,
} from './framework.js'
import { probeDocx, renderProbe } from './docx.js'
import { renderPrereqBlock } from './prereq.js'
import { renderIsolationStatus } from './isolation.js'
import { planReportGc, runReportGc, renderReportGc, ARCHIVE_ROOT_REL, BUBBLE_DIR, ARCHIVE_SCRIPT } from './report-gc.js'

/** 输出 schema：所有工具统一「中文人读 report + 结构化 JSON」两件套。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '中文人读报告。' },
    dataJson: { type: 'string', description: '结构化结果的 JSON 字符串（机器读）。' },
  },
  required: ['text', 'dataJson'],
}

/** `output.render`：把 `text` 变成模型可见的文本块。 */
const renderText = (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }]

/** 会话工作目录：多路兜底，避免某个 dsh 版本换字段名就瞎写文件。 */
export function cwdOf(exec) {
  const agent = exec?.agent
  return path.resolve(
    agent?.session?.header?.cwd
    ?? agent?.session?.cwd
    ?? agent?.cwd
    ?? process.env.DSH_WORKSPACE
    ?? process.cwd(),
  )
}

/** 参数里的 root 优先，否则用会话 cwd。 */
function rootOf(args, exec) {
  const raw = args?.root
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim())
  return cwdOf(exec)
}

/** 校验必填字符串参数。 */
function requireString(args, key, hint) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 \`${key}\` 必填${hint ? ` —— ${hint}` : ''}`)
  }
  return value.trim()
}

/** 收集某产品可用的「已知顶级菜单名」（给 doc_probe 做交叉匹配用）。 */
function knownMenusOf(root, product) {
  if (!product) return []
  const md = readText(path.join(root, product, '_框架配置', '模块路由.md'))
  if (!md) return []
  const menus = new Set()
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    for (const idx of [2, 3]) {
      const v = cells[idx]
      if (!v || v === '顶级菜单' || v === '菜单路径' || /^-+$/.test(v) || v.includes('（待登记）') || v.includes('（待补）')) continue
      // 菜单路径形如 "药品联动保障 > 缺药登记"：整串与各段都算
      for (const part of v.split('>')) {
        const p = part.trim()
        if (p && p.length <= 20) menus.add(p)
      }
    }
  }
  return [...menus]
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const TOOLS = [
  // -------------------------------------------------------------------------
  {
    name: 'test_framework_status',
    description:
      '查看当前工作区「测试工作框架」的状态：框架根在哪、有哪些产品与模块、'
      + '产品级规范（环境与账密 / 需求文档台账 / 模块路由 / 框架登记.json）登记到哪一步、'
      + '还缺哪些项（版本 / 拆分 / 跨文档关联 / 环境账密 / 模块）。'
      + '**开工前先调它**：返回的 `missing` 就是必须先问清用户的东西；`ready: false` 时不许直接开始测试。'
      + '另外它会指出「框架根没有 .git → 根 AGENTS.md 不会被 DSH 自动加载」这类会导致约束静默失效的问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '框架根路径；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '只看某个产品；省略 = 全部产品。' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const status = frameworkStatus({ root: rootOf(args, exec), product: args?.product })
      const lines = []
      lines.push('# 测试框架状态')
      lines.push('')
      if (!status.frameworkRoot) {
        lines.push('❌ **当前工作区还没有初始化测试框架。**')
        lines.push('')
        for (const w of status.warnings) lines.push(`- ${w}`)
        lines.push('')
        lines.push('→ 如果用户要做需求测试/冒泡测试/连库造数，先用 `test_framework_init` 搭骨架；')
        lines.push('  用户只是随便问问、或明确不要框架时，忽略本结论。')
      } else {
        lines.push(`- 框架根：\`${status.frameworkRoot}\`（识别依据：${status.detectedVia}）`)
        lines.push(`- 会话工作目录：\`${status.cwd}\``)
        lines.push(`- 项目根（DSH 视角，含 .git 的最近祖先）：${status.projectRoot ? `\`${status.projectRoot}\`` : '**没有**'}`)
        lines.push(`- 根 \`AGENTS.md\` 会被 DSH 自动加载：**${status.agentsMdAutoLoaded ? '是' : '否'}**`)
        lines.push(`- 产品：${status.products.length ? status.products.map((p) => p.name).join('、') : '（一个都没有）'}`)
        for (const w of status.warnings) lines.push(`- ⚠️ ${w}`)
        lines.push('')
        if (status.products.length === 0) {
          lines.push('产品目录一个都没有 —— 跑 `test_framework_init` 并指定 `product`。')
        }
        for (const p of status.products) {
          lines.push(`## 产品：${p.name}`)
          lines.push('')
          lines.push(`- 目录：\`${p.dir}\``)
          lines.push(`- 框架登记：${p.registry ? `有（\`${p.registryFile}\`）` : `**没有**（\`${p.registryFile}\`）`}`)
          lines.push(`- 已登记模块（登记表）：${(p.registry?.modules ?? []).map((m) => m?.name).filter(Boolean).join('、') || '（无）'}`)
          lines.push(`- 磁盘上的模块目录：${p.modules.map((m) => `${m.name}${m.hasSkill ? '' : '（**缺 SKILL.md**）'}`).join('、') || '（无）'}`)
          lines.push(`- 已登记需求文档：${p.documents.map((d) => `${d.name}@${d.version || '版本待确认'}`).join('；') || '（无）'}`)
          lines.push(`- 已登记环境：${p.environments.map((e) => e.name).filter(Boolean).join('、') || '（无）'}`)
          lines.push(`- **能不能直接开测：${p.ready ? '✅ 可以' : '❌ 不行，先补齐下面这些'}**`)
          lines.push('')
          if (p.missing.length) {
            lines.push('缺的项（每条都必须在会话里问用户，不许默认通过）：')
            for (const m of p.missing) lines.push(`- \`${m.key}\` → ${m.ask}`)
            lines.push('')
          }
        }
      }
      // 前置条件（必需的外部 MCP）—— **playwright 缺了就不是"能不能开测"的问题，
      // 而是"这个环境根本做不了『看着操作』类验证"**，所以单独一段列出来。
      const prereq = renderPrereqBlock(status.prereqs)
      if (prereq) {
        lines.push('')
        lines.push('## 前置条件（外部 MCP）')
        lines.push('')
        lines.push(prereq)
      }
      // 防干扰（框架边界）—— 「别的项目 / 别的框架在影响本框架」这件事，
      // 光看"框架登记齐不齐"是看不出来的（合同全对也可能契约根本没加载）。
      const isolation = renderIsolationStatus(status.isolation)
      if (isolation) {
        lines.push('')
        lines.push('## 防干扰（框架边界）')
        lines.push('')
        lines.push(isolation)
        const guard = status.frameworkRoot && path.join(status.frameworkRoot, 'skills', 'framework-guard', 'scripts', 'check_isolation.py')
        if (guard && fs.existsSync(guard)) {
          lines.push('')
          lines.push('框架内还有更全的只读自检（含代码级外部路径扫描）：'
            + '`python skills\\framework-guard\\scripts\\check_isolation.py`（退出码 0 = 干净 / 2 = 有发现）。')
        }
      }
      return { text: lines.join('\n'), dataJson: JSON.stringify(status) }
    },
    presentCall: () => ({ card: 'generic', title: '查看测试框架状态', kind: 'read' }),
    presentResult: (_a, r) => ({ card: 'generic', title: '测试框架状态', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => true,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_init',
    description:
      '把一个（空的）文件夹初始化成「测试工作框架」骨架：生成 `AGENTS.md`（框架契约，DSH 自动读取）、`README.md`、'
      + '`skills\\`（框架级 skill）、`_templates\\`（模块骨架 + 版本骨架 + 测试报告模板）、`_archive\\`、'
      + '`<产品>\\_框架配置\\`（环境与账密 / 需求文档台账 / 模块路由 / 框架登记.json）与 `<产品>\\_冒泡测试\\`（含报告回收脚本 `archive_reports.py`）`_库结构\\`，'
      + '并建好两个关键标记：`.dsh\\skills`（→ `..\\skills` 的目录联接，DSH 的 skill 发现入口）与 `.git\\`（项目根标记）。'
      + '**已存在的文件一律跳过、不覆盖**（模块 SKILL.md 永不覆盖）。传 `dryRun: true` 可以只看计划不落盘。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '目标框架根；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '产品名，如「示例产品」。必填 —— 决定 <产品>\\ 目录名。' },
        reqDocRoot: { type: 'string', description: '需求文档总根目录。省略时按「插件配置 config.reqDocRoot → 环境变量 DSH_REQ_DOC_ROOT → <用户主目录>\\需求业务文档」解析。' },
        module: { type: 'string', description: '可选：顺便建第一个模块。' },
        menu: { type: 'string', description: '可选：该模块对应的顶级菜单。' },
        route: { type: 'string', description: '可选：该模块页面路由。' },
        slug: { type: 'string', description: '可选：该模块的 kebab-case slug（如 queyao-dengji）。中文模块名不传会兜底成难记的 slug。' },
        force: { type: 'boolean', description: '覆盖已存在的**模板文件**（默认 false）。模块 SKILL.md 无论如何都不覆盖。' },
        dryRun: { type: 'boolean', description: '只出计划，不落盘。' },
        git: {
          type: 'string',
          enum: ['auto', 'skip'],
          description: 'auto（默认）= 试跑 git init，本机没 git 就建最小 .git 目录当标记；skip = 不建（会让子目录开会话时框架约束静默不加载）。',
        },
      },
      required: ['product'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const product = requireString(args, 'product', '产品名决定 <产品>\\ 目录名')
      const plan = scaffold({
        root,
        product,
        reqDocRoot: args?.reqDocRoot,
        module: args?.module,
        menu: args?.menu,
        route: args?.route,
        slug: args?.slug,
        force: args?.force === true,
        dryRun: args?.dryRun === true,
        git: args?.git === 'skip' ? 'skip' : 'auto',
        pluginVersion: PLUGIN_VERSION,
      })
      const lines = []
      lines.push(args?.dryRun === true ? '# 初始化计划（dryRun，未落盘）' : '# 测试框架已初始化')
      lines.push('')
      lines.push(`- 框架根：\`${root}\``)
      lines.push(`- 产品：\`${product}\``)
      lines.push(`- 新建 ${plan.created.length} 项｜跳过（已存在）${plan.skipped.length} 项`)
      lines.push('')
      if (plan.created.length) {
        lines.push('**新建：**')
        for (const c of plan.created) lines.push(`- ${c}`)
        lines.push('')
      }
      if (plan.skipped.length) {
        lines.push('**跳过（已存在，没覆盖）：**')
        for (const c of plan.skipped) lines.push(`- ${c}`)
        lines.push('')
      }
      if (plan.warnings.length) {
        lines.push('**⚠️ 注意：**')
        for (const w of plan.warnings) lines.push(`- ${w}`)
        lines.push('')
      }
      if (args?.dryRun !== true) {
        lines.push('## 接下来必须做的')
        lines.push('')
        lines.push('1. **核对两个标记**：`.dsh\\skills` 联接与 `.git` 目录都在吗？不在的话子目录开会话时框架约束会静默失效。')
        lines.push('2. **读一遍生成的 `AGENTS.md`**，把 §三 模块路由里空着的地方如实标「（待登记）」，不要编。')
        lines.push('3. **立刻转 `test-framework-onboard` 流程**：把「哪份需求文档 / 拆几个模块 / 哪一版 / 跨文档关联 / 环境账密」一次问清并登记。')
        lines.push('')
        lines.push('⚠️ 初始化**只搭骨架**，不包含账号密码与数据库地址 —— 那些走 `test_framework_record`。')
      }
      return { text: lines.join('\n'), dataJson: JSON.stringify(plan) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === true ? '预览测试框架初始化计划' : '初始化测试框架骨架',
      kind: args?.dryRun === true ? 'read' : 'write',
    }),
    presentResult: (_a, r) => ({ card: 'generic', title: '测试框架初始化', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => false,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_module_add',
    description:
      '在测试框架里新增一个模块（**模块 = 系统里的一个叶子菜单**；父菜单不建目录、只作菜单路径）：建 `<产品>\\<模块>\\{requirement,final,report,data,skill}`、'
      + '按 `_templates\\模块骨架\\` 渲染出模块 `SKILL.md`（**索引**：定位 / 公共约定 / §关联模块 / 版本索引），'
      + '**并按 `version` 生成该版规范 `<模块>\\skill\\<version>\\SKILL.md`**（一版一份，互不覆盖 —— 不要把多个版本融进同一份），'
      + '把模块**同时**登记到框架根 `AGENTS.md` §三 与产品级 `_框架配置\\模块路由.md`、并更新 `框架登记.json` 的 `modules[]`。'
      + '**如果模块 SKILL.md 已存在则跳过不覆盖**（它是累积型文档，要补内容请追加）。'
      + '**不传 `version` 只会建索引、不建版本规范**（会给出告警）—— 版本是必须问清的东西。'
      + '一份需求文档里含多个子模块时（如「药品联动保障」下的 缺药登记/短缺评估/余缺调拨），要**每个模块调一次** —— 但拆分方案必须先经用户确认。'
      + '\n**跨端口径（新）**：`end` = 这个模块属于哪个端（缺省取 `ends[]` 里 `default: true` 的那个）；'
      + '`businessObjects` = 逻辑业务对象（跨端对齐靠它）；`links` = 与其它模块的**业务关联边**。'
      + '命名规则：**默认端的模块名不带端前缀；非默认端必须带 `<端>-` 前缀**（如 `成员端-缺药登记`）。'
      + '\n`links` 最小示例：`links: ["缺药登记"]`（只写"我跟谁有关联"）；完整写法：'
      + '`links: [{ to: "缺药登记", kind: "审批流", businessObject: "缺药登记", handoff: "成员端审批通过后提交中心端受理办结",'
      + ' sharedTables: ["demo.t_stockout"], routes: { from: "/drugStorage", to: "/drugStorage" } }]`。'
      + '\n**落进 `relations[]` 的字段名以产品登记的规范口径为准**：`tables`（字符串）/ `fromRoute` / `toRoute` / `note`'
      + '（同时保留 `sharedTables` / `routes{from,to}` / `nameVariance`+`evidence`+`status` 作兼容别名 —— 两套都写，读哪套都行）；'
      + '入参两套写法也都收，`fromRoute` / `toRoute` / `tables` / `note` 可直接平铺传。'
      + '⚠️ 两条硬规则：① **`note` 是"人写的自由文本"，只在显式给出时才落键**（缺位时模块 SKILL.md 说明列渲染 `[自动] …` 兜底串，**不进 JSON**）；'
      + '② **幂等更新不毁数据** —— 同一条边重复登记时，本次没给的字段沿用旧值（`note` / 散文形态的 `fromRoute` / 共享表 / `已确认` 状态都不会被覆盖或降级）。'
      + '**每个模块只写本端这一条**（`A → B`），反向那条由对方模块自己登记；两边都登记后会自动标成双向。'
      + '收尾用 `test_framework_link` 复核（只读）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '框架根；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '产品名。必填。' },
        module: { type: 'string', description: '模块名（中文即可）。非默认端要带 `<端>-` 前缀，如 `成员端-缺药登记`。必填。' },
        end: { type: 'string', description: '这个模块属于哪个端（中心端 / 成员端 / 患者端 …）。缺省 = `ends[]` 里 `default: true` 的那个端。' },
        businessObjects: {
          type: 'array',
          items: { type: 'string' },
          description: '逻辑业务对象（可多个）。跨端"同一件事"靠它对齐，如 ["缺药登记"]。传字符串（含逗号分隔）也吃。',
        },
        links: {
          type: 'array',
          description: '与其它模块的业务关联边。元素可以是模块名字符串（`"缺药登记"` → 归一成 `{to, kind: "关联"}`），也可以是对象。',
          items: {
            type: ['string', 'object'],
            properties: {
              to: { type: 'string', description: '对端模块名（本产品 modules[] 里的名字）。' },
              kind: { type: 'string', description: '关联类型：审批流 / 上游依赖 / 同源同物 / 数据同源 / 关联。缺省「关联」。' },
              businessObject: { type: 'string', description: '这条边对应的逻辑业务对象。缺省取本模块 businessObjects[0]。' },
              handoff: { type: 'string', description: '交接点（哪个环节把活交给对端）。' },
              sharedTables: { type: 'array', items: { type: 'string' }, description: '共享的表（写全 schema.table）。**规范别名**：`tables`（字符串）也收。' },
              tables: { type: 'string', description: '共享表（**产品登记规范名**，字符串，可带反引号 / `<br>` 分隔）；等价于 `sharedTables`。' },
              routes: {
                type: 'object',
                properties: { from: { type: 'string' }, to: { type: 'string' } },
                description: '两端路由，如 { from: "/drugStorage", to: "/drugStorage" }（用于查路由漂移）。',
              },
              fromRoute: { type: 'string', description: '本端路由（**规范名**）；等价于 `routes.from`。' },
              toRoute: { type: 'string', description: '对端路由（**规范名**）；等价于 `routes.to`。' },
              nameVariance: { type: 'string', description: '两端名字差异说明。' },
              accounts: { type: 'array', items: { type: 'string' }, description: '联测账号。' },
              evidence: { type: 'string', description: '需求依据（文档名 §章节）。' },
              status: { type: 'string', description: '已确认 / 待核。缺省「待核」。' },
              note: { type: 'string', description: '备注（**规范名**）。**只在显式给出时才落键** —— 它是人写的自由文本，插件绝不拿 nameVariance/evidence/status 拼一个塞进登记（缺位时模块 SKILL.md 的说明列会渲染一个带 `[自动]` 前缀的兜底串，那个**不进 JSON**）。' },
              flow: { type: 'string', description: '所属链路名（可选；配 `flows[]` 用）。' },
              id: { type: 'string', description: '可选；不传就按 from|to|businessObject 稳定哈希生成。' },
            },
          },
        },
        menu: { type: 'string', description: '该模块对应的**叶子菜单**（冒泡测试靠它定位遍历范围）。' },
        menuPath: { type: 'string', description: '完整菜单路径，如「药品联动保障 > 缺药登记」。' },
        route: { type: 'string', description: '页面路由，如 /drugStorage。' },
        slug: { type: 'string', description: 'kebab-case slug（如 queyao-dengji）。中文模块名强烈建议传。' },
        doc: { type: 'string', description: '关联的需求文档名。' },
        version: { type: 'string', description: '本次测的版本。' },
        dryRun: { type: 'boolean', description: '只出计划，不落盘。' },
      },
      required: ['product', 'module'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const product = requireString(args, 'product')
      const module = requireString(args, 'module')
      const result = addModule({
        root,
        product,
        module,
        end: args?.end,
        businessObjects: args?.businessObjects,
        links: args?.links,
        menu: args?.menu,
        menuPath: args?.menuPath,
        route: args?.route,
        slug: args?.slug,
        doc: args?.doc,
        version: args?.version,
        dryRun: args?.dryRun === true,
        pluginVersion: PLUGIN_VERSION,
      })
      const lines = []
      lines.push(`# 模块「${module}」${args?.dryRun === true ? '（dryRun，未落盘）' : '已建好并登记'}`)
      lines.push('')
      lines.push(`- 模块目录：\`${path.join(root, product, module)}\``)
      lines.push(`- 模块 skill（索引）：\`${result.skillPath}\``)
      if (result.versionSkillPath) lines.push(`- 版本规范：\`${result.versionSkillPath}\``)
      lines.push(`- 生成的 slug：\`${result.slug}\``)
      if (result.end || result.businessObjects?.length) {
        lines.push('- 端：' + `\`${result.end || '（默认端）'}\`｜逻辑业务对象：`
          + (result.businessObjects?.length ? result.businessObjects.map((b) => `\`${b}\``).join('、') : '（未登记）'))
      }
      if (result.relations?.length) {
        lines.push(`- 关联边（本端视角，${result.relations.length} 条）：`)
        for (const r of result.relations) {
          const both = r.registeredOnBothSides === true ? '（已双向）' : '（**单向，等对方模块登记**）'
          lines.push(`  - \`${r.from} → ${r.to}\`｜${r.kind}｜业务对象 ${r.businessObject || '（未写）'} ${both}`)
        }
      }
      lines.push('')
      if (result.created.length) {
        lines.push('**新建/更新：**')
        for (const c of result.created) lines.push(`- ${c}`)
        lines.push('')
      }
      if (result.skipped.length) {
        lines.push('**跳过（已存在，没覆盖）：**')
        for (const c of result.skipped) lines.push(`- ${c}`)
        lines.push('')
      }
      if (result.warnings.length) {
        lines.push('**⚠️ 注意：**')
        for (const w of result.warnings) lines.push(`- ${w}`)
        lines.push('')
      }
      lines.push('## 接下来必须做的')
      lines.push('')
      lines.push('生成的模块 `SKILL.md` 是**索引**（§1 定位 / §2 关联表 / §3~§4 公共要点与坑 / §5 资料 / §6 产出 / §7 冒泡菜单 / §8 版本索引 / §9 需求文档），')
      lines.push('`skill\\<版本>\\SKILL.md` 是**该版规范**。两份都还是占位，要逐段落实（别留「待补」就交付）：')
      lines.push('- §1 的**叶子菜单 / 菜单路径 / 路由**必填 —— 冒泡测试靠它定位遍历范围；')
      lines.push('- **模块索引 §8 版本索引表**：一版一行，指向 `skill\\<版本>\\SKILL.md`；**多版本并存不覆盖**；')
      lines.push('- **§关联模块**：跨端/上下游关联要**两端都登记**（对端模块也调一次本工具、传它的 `links`），否则算单向、闸门会拦；')
      lines.push('- **版本规范里的造数逻辑**：有就照做，没有就**停下来问用户**，不许自己照着表结构编；')
      lines.push('- §9 写明需求原文文件名 + 版本 + 在需求文档总根目录的哪个系统下；**按版本记章节对应关系**；')
      lines.push('- 收尾跑一次 `test_framework_link`（只读）复核关联登记。')
      return { text: lines.join('\n'), dataJson: JSON.stringify(result) }
    },
    presentCall: (args) => ({ card: 'generic', title: `新增模块：${args?.module ?? ''}`, kind: 'write' }),
    presentResult: (_a, r) => ({ card: 'generic', title: '新增模块', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => false,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_link',
    description:
      '**跨端业务关联的只读体检**（**只读：不改登记文件、不写任何东西**）——'
      + '校验 `<产品>\\_框架配置\\框架登记.json` 的 `ends[] / modules[] / relations[] / flows[]` 是否自洽。查这些：'
      + '`E_MODULE_MISSING`（关联边的两端在 modules[] 里找不到，或磁盘上没有 `<产品>\\<模块>\\` 目录）；'
      + '`E_ONE_WAY`（只有 A→B 没有 B→A —— 跨端关联**两端必须都能查到**）；'
      + '`E_FLOW_BROKEN`（`flows[].order`／`nodes` 的相邻两跳没有对应的关联边）；'
      + '`E_END_PREFIX`（默认端的模块名带了端前缀 / 非默认端没带 `<端>-` 前缀；**例外**：整端就是一个模块时目录名 == 端名，放行）；'
      + '`W_NO_BUSINESS_OBJECT`（非默认端模块没登记逻辑业务对象）；'
      + '`W_ROUTE_DRIFT`（关联边上的路由与模块登记的路由**路径**对不上，只算提示）；'
      + '`W_REGISTERED_IN`（模块没同时登记到 AGENTS.md §三 与 `_框架配置\\模块路由.md`）；'
      + '`W_WHOLE_END_MODULE`（整端一个模块的例外，提醒写进 `模块关联.md` §1）；'
      + '`W_DUPLICATE_MODULE`（同一模块在 `modules[]` 里重复登记了多条）。'
      + '返回结论行 + 错误清单（code/target/message）+ 摘要（模块数 / 关联边数 / 链路数 / 各端模块数）。'
      + '登记或改动关联边之后跑它，别等闸门拦住才发现。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '框架根；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '产品名；省略 = 全部产品。' },
        detail: { type: 'number', description: '0（默认）= 只列错误；1 = 连 warning 一起逐条列。' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const detail = Number(args?.detail ?? 0) === 1
      const products = typeof args?.product === 'string' && args.product.trim() !== ''
        ? [args.product.trim()]
        : listProducts(root)
      const lines = []
      const payload = { root, ok: true, products: [] }
      lines.push('# 跨端关联体检（**只读**，未改任何文件）')
      lines.push('')
      lines.push(`- 框架根：\`${root}\``)
      if (products.length === 0) {
        lines.push('- 没找到任何产品 —— 先跑 `test_framework_init` / `test_framework_module_add`。')
        payload.ok = false
        return { text: lines.join('\n'), dataJson: JSON.stringify(payload) }
      }
      let ok = true
      for (const product of products) {
        const r = checkLinks({ root, product })
        ok = ok && r.ok
        payload.products.push(r)
        lines.push('')
        lines.push(`## 产品「${product}」：${r.ok ? '✅ 关联登记自洽' : `❌ 有 ${r.errors.length} 条错误`}`
          + (r.warnings.length ? `｜${r.warnings.length} 条提示` : ''))
        lines.push('')
        lines.push(`摘要：模块 ${r.summary.modules} 个｜关联边 ${r.summary.relations} 条｜链路 ${r.summary.flows} 条｜端 ${r.summary.ends} 个`
          + `（默认端：${r.summary.defaultEnd || '（未声明）'}）`)
        const byEnd = Object.entries(r.summary.byEnd)
        if (byEnd.length) {
          lines.push('')
          lines.push(`各端模块数：${byEnd.map(([k, v]) => `${k} ${v}`).join('｜')}`)
        }
        const list = detail ? [...r.errors, ...r.warnings] : r.errors
        lines.push('')
        if (list.length) {
          lines.push(detail ? '**逐条（错误 + 提示）：**' : '**错误清单：**')
          for (const e of list) lines.push(`- \`${e.code}\`｜${e.target || '—'}｜${e.message}`)
        } else {
          lines.push('- 没有错误。')
        }
        if (!detail && r.warnings.length) {
          lines.push('')
          lines.push(`> 另有 ${r.warnings.length} 条提示（路由漂移这类刻意只算 warning，不拦人）；要看传 \`detail: 1\`。`)
        }
      }
      payload.ok = ok
      lines.push('')
      lines.push(ok
        ? '**结论：关联登记自洽，没有错误。**（warning 不影响结论，但值得看一眼）'
        : '**结论：存在关联登记问题（见上）—— 补齐后重跑本工具；闸门 `linksChecked` 认的就是这几条。**')
      return { text: lines.join('\n'), dataJson: JSON.stringify(payload) }
    },
    presentCall: () => ({ card: 'generic', title: '跨端关联体检（只读）', kind: 'read' }),
    presentResult: (_a, r) => ({ card: 'generic', title: '跨端关联体检', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => true,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_record',
    description:
      '把「需求文档登记」或「测试环境与账密登记」写进**产品级规范**（`<产品>\\_框架配置\\`）：'
      + '既写人能读的 Markdown（`需求文档台账.md` / `环境与账密.md`），也写机器可读的 `框架登记.json`。'
      + '`kind: "document"` 登记需求文档的**版本 / 页数 / 拆分出的模块 / 关联的其它需求文档 / 取消项核对进展**；'
      + '`kind: "environment"` 登记**测试环境地址、页面账号密码、数据库地址与账号密码、数据地址**。'
      + '⚠️ 口径：`split` 为空 = 拆分未确认；`relatedDocs` **缺 key** = 跨文档关联还没问过（写 `[]` 表示问过了、答「没有」）；两者都会让闸门继续拦住。'
      + '⚠️ 明文密码只进 `环境与账密.md`，`框架登记.json` 里只记指针。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['document', 'environment'], description: '登记哪一类。' },
        root: { type: 'string', description: '框架根；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '产品名。必填。' },
        documents: {
          type: 'array',
          description: 'kind=document 时必填。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: '需求文档名（含扩展名更好）。' },
              system: { type: 'string', description: '所属系统（需求文档总根目录下的子目录名）。' },
              version: { type: 'string', description: '本次测的版本。用户没确认就别填。' },
              pages: { type: 'number', description: '页数（探针给的）。' },
              path: { type: 'string', description: '文档绝对路径。' },
              split: { type: 'array', items: { type: 'string' }, description: '拆分出的模块名。' },
              splitConfirmed: { type: 'boolean', description: '用户是否确认过拆分方案。' },
              relatedDocs: { type: 'array', items: { type: 'string' }, description: '本地关联的其它需求文档绝对路径；**问过了答没有就传 []**。' },
              cancelledItemCheck: { type: 'string', description: '划掉项核对进展：未做 / 已同步取消 / 未取消(残留) / 无法判定' },
              note: { type: 'string', description: '备注（用户原话里的例外、范围外说明等）。' },
            },
            required: ['name'],
          },
        },
        environments: {
          type: 'array',
          description: 'kind=environment 时必填。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: '环境名，如「主环境」「某地环境」。' },
              url: { type: 'string', description: '页面入口 URL。' },
              dbHost: { type: 'string' },
              dbPort: { type: 'string' },
              dbName: { type: 'string' },
              schema: { type: 'string' },
              account: { type: 'string', description: '页面账号。' },
              password: { type: 'string', description: '页面密码（只落 md）。' },
              role: { type: 'string', description: '角色，如「管理员」。' },
              dbUser: { type: 'string', description: '数据库用户名。' },
              dbPassword: { type: 'string', description: '数据库密码（只落 md）。' },
              canWrite: { type: 'string', description: '只读 / 可造数。' },
              note: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      required: ['kind', 'product'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const product = requireString(args, 'product')
      const kind = requireString(args, 'kind')
      const out = { kind, product, written: [], warnings: [] }
      if (kind === 'document') {
        if (!Array.isArray(args?.documents) || args.documents.length === 0) {
          throw new Error('kind=document 时必须给 `documents` 数组（至少一条）')
        }
        const r = recordDocuments(root, product, args.documents, { pluginVersion: PLUGIN_VERSION })
        out.written.push(...r.written)
        out.warnings.push(...r.warnings)
      } else if (kind === 'environment') {
        if (!Array.isArray(args?.environments) || args.environments.length === 0) {
          throw new Error('kind=environment 时必须给 `environments` 数组（至少一条）')
        }
        const r = recordEnvironments(root, product, args.environments, { pluginVersion: PLUGIN_VERSION })
        out.written.push(...r.written)
        out.warnings.push(...r.warnings)
      } else {
        throw new Error(`kind 只能是 "document" 或 "environment"，收到 "${kind}"`)
      }
      const status = frameworkStatus({ root, product })
      const p = status.products[0]
      out.gates = p?.gates
      out.missing = p?.missing ?? []
      out.ready = p?.ready ?? false

      const lines = []
      lines.push(`# 已登记（${kind === 'document' ? '需求文档' : '测试环境与账密'}）`)
      lines.push('')
      lines.push(`- 产品：\`${product}\``)
      for (const w of out.written) lines.push(`- 已写入：\`${w}\``)
      for (const w of out.warnings) lines.push(`- ⚠️ ${w}`)
      lines.push('')
      lines.push(`## 闸门状态：${out.ready ? '✅ 全部通过，可以开测' : '❌ 还有没做完的'}`)
      lines.push('')
      if (out.gates) {
        for (const [k, v] of Object.entries(out.gates)) lines.push(`- ${v ? '✅' : '⬜'} \`${k}\``)
      }
      if (out.missing.length) {
        lines.push('')
        lines.push('**还缺：**')
        for (const m of out.missing) lines.push(`- \`${m.key}\` → ${m.ask}`)
      }
      return { text: lines.join('\n'), dataJson: JSON.stringify(out) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.kind === 'environment' ? '登记测试环境与账密' : '登记需求文档',
      kind: 'write',
    }),
    presentResult: (_a, r) => ({ card: 'generic', title: '登记产品级规范', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => false,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_doc_probe',
    description:
      '探一份需求文档（docx），给出**结构摘要**与**拆分判定**：页数（优先取 Word `docProps/app.xml` 的 Pages，取不到会标明是估算）、'
      + '章节树、表格数、图片数、**带删除线的段落数**、疑似子模块、命中的顶级菜单名，'
      + '以及「要不要停下来问用户拆分」的结论与依据。'
      + '**零依赖、不修改文档**；加密文档（OLE 容器）会认出来并告诉你要先解密。'
      + '用途：需求文档动辄 100+ 页，模型不可能整篇读进来 —— 先探结构，再让用户确认拆分方案。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文档绝对路径（.docx）。必填。' },
        product: { type: 'string', description: '产品名：给了就去读它的 `_框架配置\\模块路由.md`，拿顶级菜单名做交叉匹配（最硬的拆分判据）。' },
        root: { type: 'string', description: '框架根；省略 = 当前会话工作区。' },
        knownMenus: { type: 'array', items: { type: 'string' }, description: '直接指定已知顶级菜单名（不给 product 时用）。' },
        pageThreshold: { type: 'number', description: '页数阈值，默认 100。' },
        maxHeadings: { type: 'number', description: '返回的章节树上限，默认 120。' },
      },
      required: ['path'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const file = requireString(args, 'path', '要探的 docx 绝对路径')
      if (!isFile(file)) throw new Error(`文件不存在：${file}`)
      const root = rootOf(args, exec)
      const knownMenus = [
        ...(Array.isArray(args?.knownMenus) ? args.knownMenus : []),
        ...knownMenusOf(root, args?.product),
      ]
      const report = probeDocx(file, {
        knownMenus: [...new Set(knownMenus)],
        pageThreshold: typeof args?.pageThreshold === 'number' ? args.pageThreshold : 100,
        maxHeadings: typeof args?.maxHeadings === 'number' ? args.maxHeadings : 120,
      })
      const text = renderProbe(report) + (knownMenus.length
        ? `\n\n> 本次交叉匹配用的顶级菜单名（${knownMenus.length} 个）：${knownMenus.join('、')}`
        : '\n\n> ⚠️ 没有可用的「已知顶级菜单名」—— 传 `product` 或 `knownMenus` 能让拆分判定硬得多'
          + '（菜单名命中是最不容易误报的判据）。')
      return { text, dataJson: JSON.stringify(report) }
    },
    presentCall: (args) => ({ card: 'generic', title: `探需求文档：${path.basename(String(args?.path ?? ''))}`, kind: 'read' }),
    presentResult: (_a, r) => ({ card: 'generic', title: '需求文档探针', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => true,
  },

  // -------------------------------------------------------------------------
  {
    name: 'test_framework_report_gc',
    description:
      '测试报告**回收**：把满 N 小时（默认 24）的测试报告从模块 `report\\` 移进 `_archive\\报告归档\\<模块>\\<日期>\\`，'
      + '让模块目录不堆报告。**是归档（移动）不是删除** —— 归档台账记着原文件名与日期，随时能搬回来。'
      + '覆盖 `report\\` 下**全部 `*.md`**，但默认**跳过两类常驻文档**：文件名以 `_` 开头的、'
      + '以及文件名里没有 8 位日期且不以 `冒泡测试-` 开头的（那是跨多轮在用的活文档，搬走会打断工作流）；'
      + '要连它们一起收就传 `all: true`。'
      + '⚠️ **默认 `dryRun: true` 只预演**，先看会动哪些；确认后传 `dryRun: false` 才真搬。'
      + '「每小时自动跑」那半部分由计划任务调用同一个脚本完成，本工具是"现在就想清一下"的手动入口。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '框架根；省略 = 当前会话工作区。' },
        product: { type: 'string', description: '用哪个产品下的归档脚本；省略 = 自动挑（脚本本身会遍历所有产品）。' },
        hours: { type: 'number', description: '阈值小时数，默认 24。' },
        all: { type: 'boolean', description: '连“常驻文档”（`_` 开头 / 无日期的）一起归档。默认 false。' },
        dryRun: { type: 'boolean', description: '默认 **true**（只预演不搬）。要真归档传 false。' },
        python: { type: 'string', description: '指定 python 解释器（绝对路径或命令名）；省略 = 自动找 python / python3 / py。' },
      },
      required: [],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const root = rootOf(args, exec)
      const result = runReportGc({
        root,
        product: args?.product,
        hours: typeof args?.hours === 'number' ? args.hours : undefined,
        all: args?.all === true,
        dryRun: args?.dryRun !== false,
        python: typeof args?.python === 'string' && args.python.trim() ? args.python.trim() : undefined,
        deps: { listProducts },
      })
      return {
        text: renderReportGc(result),
        dataJson: JSON.stringify({
          ok: result.ok,
          status: result.status,
          inherited: result.inherited,
          output: result.output,
          plan: result.plan,
          failure: result.failure,
        }),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false ? '回收测试报告（真归档）' : '回收测试报告（预演）',
      kind: args?.dryRun === false ? 'write' : 'read',
    }),
    presentResult: (_a, r) => ({ card: 'generic', title: '报告回收', ...(r?.isError ? { kind: 'error' } : {}) }),
    isConcurrencySafe: () => false,
  },
]

/** 插件版本（工具输出里带上，便于排查"装的是哪一版"）。由 index.js 注入。 */
export let PLUGIN_VERSION = 'unknown'
export function setPluginVersion(v) {
  PLUGIN_VERSION = v
}

export { renderGate, listProducts, ensureRegistry, missingItems }
