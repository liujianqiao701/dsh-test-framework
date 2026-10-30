#!/usr/bin/env node
/**
 * `dsh-test-framework` 命令行入口。
 *
 * 存在的理由：**装插件这一步必须在 DSH 外面做**（要写 profile 的 package.json，还要重启 DSH），
 * 而那时模型工具还没上线。所以把「初始化框架 / 装插件 / 体检 / 探文档」四件事做成 CLI。
 *
 * 用法：`dsh-test-framework <命令> [参数]`，或 `node <插件目录>\lib\cli.js <命令>`。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scaffold, frameworkStatus, renderGate, checkLinks, defaultReqDocRoot, listProducts } from './framework.js'
import { probeDocx, renderProbe } from './docx.js'
import { planInstall, applyInstall, applyUninstall, doctor, defaultDshHome } from './install.js'
import { runReportGc, renderReportGc } from './report-gc.js'
import { checkPromptBudget, budgetSummary, BUDGET_FIX, LEVEL_OK, LEVEL_OVER, LEVEL_TIGHT } from './budget.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const PLUGIN_META = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
  } catch {
    return { name: 'dsh-test-framework', version: 'unknown' }
  }
})()

/** 极简参数解析：只认 `--key value` 与 `--flag`。 */
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

const HELP = `
dsh-test-framework v${PLUGIN_META.version} —— 测试工作框架插件

用法：
  dsh-test-framework init    --product "<产品名>" [--root <目录>] [--req-doc-root <目录>]
                             [--module <模块>] [--menu <菜单>] [--route <路由>] [--slug <slug>]
                             [--dry-run]
       把（空的）文件夹初始化成测试框架骨架（AGENTS.md / skills / _templates / _archive /
       <产品>\\_框架配置 / .git / .dsh\\skills）。**已存在的文件一律跳过，不覆盖。**

  dsh-test-framework status  [--root <目录>]
       打印当前框架状态与「还缺哪些登记项」。

  dsh-test-framework link    [--root <目录>] [--product <产品>] [--json] [--detail]
       跨端业务关联**只读体检**（与工具 test_framework_link 行为一致，**不改任何文件**）：
       查 关联边两端是否存在（registry + 磁盘目录）/ 单向边 / 链路断点 / 端前缀命名 /
       非默认端没写业务对象 / 路由漂移 / 模块登记落点缺失。
       退出码 0 = 没有错误（warning 不算），1 = 有错误。 --json 出机器可读整包。

  dsh-test-framework probe   "<docx 绝对路径>" [--product <产品>] [--threshold <页数>]
       探一份需求文档：页数 / 章节树 / 图片数 / 划掉段落数 / 疑似子模块 / 要不要拆分。

  dsh-test-framework report-gc [--root <目录>] [--product <产品>] [--hours 24] [--all] [--dry-run]
                               [--python <解释器>]
       报告回收：把满 N 小时（默认 24）的测试报告从 <模块>\\report\\ 移到
       _archive\\报告归档\\<模块>\\<日期>\\。**是归档不是删除**，随时能搬回来。
       默认跳过"常驻文档"（_ 开头 / 文件名没 8 位日期的）；要一起收加 --all。
       先看会动什么：加 --dry-run。CLI 是显式敲的，所以**不加 --dry-run 就是真归档**。
       逻辑不重写：本命令调用每个产品 _冒泡测试\\archive_reports.py（与计划任务同一个脚本）。

  dsh-test-framework budget  [--root <目录>] [--max-bytes <N>] [--reserve <N>] [--json]
       提示词预算预检：DSH 把工作区指令（根 AGENTS.md + %USERPROFILE%\\.dsh\\AGENTS.md）
       **渲染成一条基线消息**注入，上限 65536 字节。超了 DSH 会先丢宽范围文件、再**截断**
       最具体那份（就是 AGENTS.md）—— **不报错**，只是契约少一截。
       本命令按 DSH 的渲染口径**按字节复算**并给结论：ok / tight（余量 < 1024）/ over。
       退出码 0 = 在限内且余量够；2 = 告急或已超；1 = 自身出错。

  dsh-test-framework install [--profile <名字>] [--apply] [--official] [--pnpm] [--dsh <路径>]
       把本插件装进 dsh profile。**默认只打印计划**；要真装加 --apply。
       默认走**链接安装**（改 profile 的 dependencies + dsh.profile.bundles + 建目录联接），
       **不跑 pnpm** —— 因为跑 pnpm 会动整棵 node_modules，而本机 profile 是多个 dsh 版本
       混链的状态，有被"规范化"的风险。
       --official 改用官方 \`dsh plugin --profile <名字> add link:<插件目录>\`（**会真跑 pnpm**）；
       --pnpm 在链接安装之后再补跑一次 pnpm install（一般不需要）。

  dsh-test-framework uninstall [--profile <名字>]
       从 profile 摘掉依赖与 bundles 条目（先备份；**不动框架工作区里的任何文件**）。

  dsh-test-framework doctor [--profile <名字>] [--dsh <路径>]
       体检：插件清单 / 入口 / patch 文件 / Node 版本 / dsh 与 pnpm 是否找得到 / 装没装上。
       dsh 可执行文件按「PATH → 这个 profile 自己链的那个 → npm 全局 → npx 缓存（版本降序）」
       的顺序挑；本机 npx 缓存里有多个 dsh 时会一并列出，可用 --dsh 指定。

  dsh-test-framework help
       本帮助。

环境变量：DSH_HOME（默认 %USERPROFILE%\\.dsh）
`.trim()

/** 打印框架状态。 */
function cmdStatus(args) {
  const status = frameworkStatus({ root: args.root ? path.resolve(args.root) : process.cwd() })
  const lines = []
  lines.push(`框架根：${status.frameworkRoot ?? '（未识别 —— 这个地方还没初始化框架）'}`)
  if (status.detectedVia) lines.push(`识别依据：${status.detectedVia}`)
  lines.push(`项目根（DSH 视角）：${status.projectRoot ?? '（没有 .git，根 AGENTS.md 不会被自动加载）'}`)
  lines.push('')
  const gate = renderGate(status)
  lines.push(gate || '✅ 无待补项。')
  lines.push('')
  lines.push(`提示词预算：${budgetSummary(status.promptBudget) || '（未能测量）'}`)
  for (const w of status.warnings) lines.push(`⚠️ ${w}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return status.frameworkRoot ? 0 : 1
}

/** 初始化骨架。 */
function cmdInit(args) {
  const product = args.product
  if (typeof product !== 'string' || product.trim() === '') {
    process.stderr.write('❌ init 需要 --product "<产品名>"\n')
    return 2
  }
  const root = args.root ? path.resolve(args.root) : process.cwd()
  const plan = scaffold({
    root,
    product: product.trim(),
    reqDocRoot: typeof args['req-doc-root'] === 'string' ? args['req-doc-root'] : undefined,
    module: typeof args.module === 'string' ? args.module : undefined,
    menu: typeof args.menu === 'string' ? args.menu : undefined,
    route: typeof args.route === 'string' ? args.route : undefined,
    slug: typeof args.slug === 'string' ? args.slug : undefined,
    dryRun: args['dry-run'] === true,
    pluginVersion: PLUGIN_META.version,
  })
  const lines = []
  lines.push(args['dry-run'] === true ? '【dryRun】以下是要做的事，未落盘：' : '✅ 框架骨架已生成：')
  lines.push(`   框架根：${root}`)
  lines.push(`   产品：${product}`)
  if (plan.created.length) {
    lines.push(`   新建 ${plan.created.length} 项：`)
    for (const c of plan.created) lines.push(`     + ${c}`)
  }
  if (plan.skipped.length) {
    lines.push(`   跳过（已存在，未覆盖）${plan.skipped.length} 项：`)
    for (const c of plan.skipped) lines.push(`     = ${c}`)
  }
  if (plan.warnings.length) {
    lines.push('   ⚠️ 注意：')
    for (const w of plan.warnings) lines.push(`     ! ${w}`)
  }
  if (args['dry-run'] !== true) {
    lines.push('')
    lines.push('接下来：① 核对 .git 与 .dsh\\skills 都建上了；')
    lines.push('        ② 读一遍生成的 AGENTS.md；')
    lines.push('        ③ 在 DSH 会话里走「新需求文档引导流程」把版本 / 拆分 / 跨文档关联 / 环境账密登记齐。')
    lines.push(`   需求文档总根目录默认：${defaultReqDocRoot()}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** 跨端关联体检（**只读**，与工具 `test_framework_link` 行为一致）。 */
function cmdLink(args) {
  const root = args.root ? path.resolve(args.root) : process.cwd()
  const json = args.json === true
  const products = typeof args.product === 'string' && args.product.trim() !== ''
    ? [args.product.trim()]
    : listProducts(root)
  if (products.length === 0) {
    process.stderr.write(`❌ 在 ${root} 下没找到任何产品（先跑 init / 在会话里用 test_framework_module_add）\n`)
    return 1
  }
  const results = products.map((product) => checkLinks({ root, product }))
  if (json) {
    process.stdout.write(`${JSON.stringify({ root, ok: results.every((r) => r.ok), products: results }, null, 2)}\n`)
    return results.every((r) => r.ok) ? 0 : 1
  }
  const lines = []
  lines.push(`跨端关联体检（只读）｜ 框架根：${root}`)
  for (const r of results) {
    lines.push('')
    lines.push(`【${r.summary.product}】${r.ok ? '✅ 关联登记自洽' : `❌ 有 ${r.errors.length} 条错误`}`
      + (r.warnings.length ? `｜${r.warnings.length} 条提示` : ''))
    lines.push(`  摘要：模块 ${r.summary.modules} 个｜关联边 ${r.summary.relations} 条｜链路 ${r.summary.flows} 条`
      + `｜端 ${r.summary.ends} 个（默认端：${r.summary.defaultEnd || '（未声明）'}）`)
    const byEnd = Object.entries(r.summary.byEnd)
    if (byEnd.length) lines.push(`  各端模块数：${byEnd.map(([k, v]) => `${k} ${v}`).join('｜')}`)
    const list = args.detail === true ? [...r.errors, ...r.warnings] : r.errors
    if (list.length) {
      lines.push(args.detail === true ? '  逐条（错误 + 提示）：' : '  错误清单：')
      for (const e of list) lines.push(`    - ${e.code}｜${e.target || '—'}｜${e.message}`)
    } else {
      lines.push('  没有错误。')
    }
    if (args.detail !== true && r.warnings.length) lines.push(`  （另有 ${r.warnings.length} 条提示；加 --detail 看）`)
  }
  lines.push('')
  lines.push(results.every((r) => r.ok)
    ? '结论：关联登记自洽，没有错误。'
    : '结论：存在关联登记问题（见上）—— 补齐后重跑；闸门 linksChecked 认的就是这几条。')
  process.stdout.write(`${lines.join('\n')}\n`)
  return results.every((r) => r.ok) ? 0 : 1
}

/** 探文档。 */
function cmdProbe(args) {
  const file = args._[0]
  if (!file) {
    process.stderr.write('❌ probe 需要文档路径：dsh-test-framework probe "<文件.docx>"\n')
    return 2
  }
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) {
    process.stderr.write(`❌ 文件不存在：${abs}\n`)
    return 2
  }
  let knownMenus = []
  if (typeof args.product === 'string') {
    const routeMd = path.join(process.cwd(), args.product, '_框架配置', '模块路由.md')
    try {
      knownMenus = [...fs.readFileSync(routeMd, 'utf8').matchAll(/\|\s*([^|\n]{2,20}?)\s*\|/g)].map((m) => m[1])
    } catch {
      /* 读不到就算了 */
    }
  }
  const report = probeDocx(abs, {
    knownMenus,
    pageThreshold: args.threshold ? Number(args.threshold) : 100,
  })
  process.stdout.write(`${renderProbe(report)}\n`)
  return 0
}

/** 安装。 */
function cmdInstall(args) {
  const profile = typeof args.profile === 'string' ? args.profile : undefined
  const dsh = typeof args.dsh === 'string' ? args.dsh : undefined
  const plan = planInstall({ pluginDir: PLUGIN_DIR, profile, dshHome: defaultDshHome(), dsh })
  const lines = []
  lines.push(`插件：${plan.plugin?.name ?? '?'}@${plan.plugin?.version ?? '?'}`)
  lines.push(`插件目录：${plan.pluginDir}`)
  lines.push(`DSH_HOME：${plan.dshHome}`)
  lines.push(`现有 profile：${(plan.availableProfiles ?? []).join('、') || '（一个都没有）'}`)
  lines.push('')
  if (plan.errors.length) {
    for (const e of plan.errors) lines.push(`❌ ${e}`)
    if (!profile) lines.push('→ 用 --profile <名字> 指定要装进哪个 profile。')
    process.stdout.write(`${lines.join('\n')}\n`)
    return 1
  }
  if (plan.dsh) lines.push(`将用 dsh：${plan.dsh.command}（${plan.dsh.via}，版本 ${plan.dsh.version}）`)
  for (const w of plan.warnings) lines.push(`⚠️ ${w}`)
  lines.push('计划：')
  for (const s of plan.steps) lines.push(`  · ${s}`)
  lines.push('')
  if (args.apply !== true) {
    lines.push('以上**只是计划，没有落盘**。要真装，重跑并加 --apply：')
    lines.push(`  dsh-test-framework install --profile ${profile} --apply`)
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }
  const result = applyInstall({
    pluginDir: PLUGIN_DIR,
    profile,
    dshHome: defaultDshHome(),
    mode: args.official === true ? 'official' : 'link',
    runPnpm: args.pnpm === true,
    dsh,
  })
  lines.push(result.ok ? `✅ 安装完成（方式：${result.used}）` : `❌ 安装未完成（方式：${result.used}）`)
  if (result.backup) lines.push(`   备份：${result.backup}`)
  if (result.output) lines.push(`\n${result.output}`)
  if (result.error) lines.push(`\n❌ ${result.error}`)
  lines.push('')
  for (const n of result.next ?? []) lines.push(`→ ${n}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return result.ok ? 0 : 1
}

/** 卸载。 */
function cmdUninstall(args) {
  const profile = typeof args.profile === 'string' ? args.profile : undefined
  if (!profile) {
    process.stderr.write('❌ uninstall 需要 --profile <名字>\n')
    return 2
  }
  const r = applyUninstall({ pluginDir: PLUGIN_DIR, profile, dshHome: defaultDshHome() })
  const lines = [r.ok ? '✅ 已卸载' : '❌ 卸载失败']
  if (r.backup) lines.push(`   备份：${r.backup}`)
  if (r.output) lines.push(`\n${r.output}`)
  if (r.error) lines.push(`\n❌ ${r.error}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return r.ok ? 0 : 1
}

/** 提示词预算预检。 */
function cmdBudget(args) {
  const root = args.root ? path.resolve(args.root) : process.cwd()
  const num = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
  let result
  try {
    result = checkPromptBudget({ root, maxBytes: num(args['max-bytes']), reserve: num(args.reserve) })
  } catch (err) {
    process.stderr.write(`❌ 预检失败：${err?.message ?? err}\n`)
    return 1
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const lines = [`提示词预算预检（DSH workspace-instructions，上限 ${result.maxBytes} 字节）`, '']
    for (const f of result.files) lines.push(`  ${f.displayPath.padEnd(24)} ${String(f.bytes).padStart(8)} 字节`)
    lines.push(`  ${'固定开销（标签+前言+段头）'.padEnd(20)} ${String(result.overhead).padStart(8)} 字节`)
    lines.push(`  ${'-'.repeat(44)}`)
    lines.push(`  已用 ${result.used} / ${result.maxBytes} 字节（${Math.round((result.ratio ?? 0) * 100)}%），余 ${result.headroom} 字节`)
    lines.push('')
    if (result.level === LEVEL_OVER) {
      lines.push(`  ❌ 已超预算 ${-result.headroom} 字节 —— \`AGENTS.md\` 会被截断（不报错，只是契约少一截）。`)
    } else if (result.level === LEVEL_TIGHT) {
      lines.push(`  ⚠️ 余量告急（< ${result.reserve} 字节警戒线）—— 再加一两段就会踩线。`)
    } else {
      lines.push(`  ✅ 在预算内，余量 ${result.headroom} 字节。`)
    }
    if (result.level !== LEVEL_OK) {
      lines.push('')
      lines.push(`  处置：${BUDGET_FIX}`)
    }
    for (const p of result.absent) lines.push('')
    if (result.absent.length) lines.push(`  （用户级 AGENTS.md 不存在，未计入：${result.absent.join('、')}）`)
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return result.level === LEVEL_OK ? 0 : 2
}

/** 体检。 */
function cmdDoctor(args) {
  const profile = typeof args.profile === 'string' ? args.profile : undefined
  const report = doctor({
    pluginDir: PLUGIN_DIR,
    profile,
    dshHome: defaultDshHome(),
    dsh: typeof args.dsh === 'string' ? args.dsh : undefined,
  })
  const lines = [`dsh-test-framework v${PLUGIN_META.version} 体检`, '']
  for (const c of report.checks) lines.push(`${c.ok ? '✅' : '⬜'} ${c.label} —— ${c.detail}`)
  if (report.alternatives?.length > 1) {
    lines.push('')
    lines.push(`本机 npx 缓存里还有 ${report.alternatives.length} 个 dsh（按版本降序），可用 --dsh <路径> 指定：`)
    for (const a of report.alternatives) lines.push(`  · ${a.version}  ${a.path}`)
  }
  lines.push('')
  if (report.ok) {
    lines.push('全部通过。')
    if (!profile) lines.push('（没给 --profile，跳过了「装没装上」这一项 —— 加 `--profile <名字>` 再跑一次。）')
  } else {
    lines.push('有未通过的项 —— 按上面的顺序处理；')
    lines.push('装插件用：dsh-test-framework install --profile <名字> --apply')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return report.ok ? 0 : 1
}

/** 报告回收（归档）。 */
function cmdReportGc(args) {
  const root = args.root ? path.resolve(args.root) : process.cwd()
  const hours = typeof args.hours === 'string' ? Number(args.hours) : undefined
  const result = runReportGc({
    root,
    product: typeof args.product === 'string' ? args.product : undefined,
    hours: Number.isFinite(hours) ? hours : undefined,
    all: args.all === true,
    // CLI 是人在终端里显式敲的，所以**默认真归档**；要看预演加 --dry-run。
    dryRun: args['dry-run'] === true,
    python: typeof args.python === 'string' ? args.python : undefined,
    deps: { listProducts },
  })
  process.stdout.write(`${renderReportGc(result)}\n`)
  return result.ok ? 0 : 1
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'help'
  const args = parseArgs(argv.slice(1))
  switch (command) {
    case 'init': return cmdInit(args)
    case 'status': return cmdStatus(args)
    case 'link': return cmdLink(args)
    case 'probe': return cmdProbe(args)
    case 'report-gc': return cmdReportGc(args)
    case 'budget': return cmdBudget(args)
    case 'install': return cmdInstall(args)
    case 'uninstall': return cmdUninstall(args)
    case 'doctor': return cmdDoctor(args)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`)
      return 0
    case '--version':
    case '-v':
      process.stdout.write(`${PLUGIN_META.version}\n`)
      return 0
    default:
      process.stderr.write(`❌ 未知命令「${command}」\n\n${HELP}\n`)
      return 2
  }
}

process.exitCode = main()
