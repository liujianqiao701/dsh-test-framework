/**
 * 报告回收（归档）：把满 N 小时的测试报告从模块 `report\` 移进 `_archive\报告归档\`。
 *
 * ## 为什么是「调脚本」而不是「再写一份 JS」
 *
 * 归档这件事实机上**已经有唯一权威实现** —— 每个产品 `_冒泡测试\archive_reports.py`，
 * 由 Windows 计划任务每小时跑一次（自动那半部分）。如果插件再写一份 JS，
 * 就有了两个实现，规则一改必然漂移，而"哪个才是真的"没人说得清。
 *
 * 所以插件只做三件事，**逻辑不重复**：
 *   ① 找到那份脚本（框架根下有多个产品时挑配置对齐的那个）；
 *   ② 找到 python 解释器；
 *   ③ 把 `--hours / --all / --dry-run` 透传过去，并把结果翻译成人看得懂的话。
 *
 * 脚本缺失时**不猜、不模仿**，直接告诉用户去哪儿拿（插件模板里有规范版）。
 *
 * ## 关于沙箱
 *
 * 跑子进程走 `install.js` 的 `runCapture` —— 它已经处理了本机的两个坑：
 * Windows 上 spawn `.cmd` 要 `shell: true`，而受限沙箱里带管道会 `EPERM`
 * （这时降级成 `inherit`，输出直接进终端、程序里只拿退出码）。所以返回里会有
 * `inherited: true` 的情况，**必须如实转达给用户，不能假装读到了内容**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runCapture } from './install.js'
import { findFrameworkRoot, CONFIG_DIR } from './framework.js'

/** 归档脚本所在的辅助目录名。 */
export const BUBBLE_DIR = '_冒泡测试'
/** 归档脚本文件名。 */
export const ARCHIVE_SCRIPT = 'archive_reports.py'
/** 归档区相对路径。 */
export const ARCHIVE_ROOT_REL = path.join('_archive', '报告归档')
/** 默认阈值（小时）。 */
export const DEFAULT_HOURS = 24

/** 候选 python 解释器（按优先级）。`py` 是 Windows 的启动器，没装 python 时经常还有它。 */
const PYTHON_CANDIDATES = ['python', 'python3', 'py']

/**
 * 找一个能用的 python 解释器。
 *
 * @returns {{command: string, version?: string, tried: string[]}|null}
 */
export function findPython({ candidates = PYTHON_CANDIDATES } = {}) {
  const tried = []
  for (const cmd of candidates) {
    tried.push(cmd)
    const r = runCapture(cmd, ['--version'], { timeout: 20000, quietFallback: true })
    if (r.status === 0 && !r.error) {
      const version = (r.combined.match(/Python\s+([\d.]+)/) ?? [])[1]
      return { command: cmd, version, tried }
    }
  }
  return null
}

/**
 * 列出框架根下**有归档脚本**的产品。
 *
 * 脚本是产品级放置的（`<产品>\_冒泡测试\archive_reports.py`），但**脚本自己会遍历所有产品**，
 * 所以拿任意一个都能回收全框架 —— 这里只负责挑一个"配置对齐"的出来。
 */
export function productsWithScript(root, { listProducts }) {
  const out = []
  let names = []
  try {
    names = listProducts(root)
  } catch {
    names = []
  }
  for (const name of names) {
    const abs = path.join(root, name, BUBBLE_DIR, ARCHIVE_SCRIPT)
    if (fs.existsSync(abs)) out.push({ product: name, script: abs })
  }
  return out
}

/**
 * 规划一次报告回收：**只算路径与参数，不动任何文件**。
 *
 * @param {object} options
 * @param {string} [options.root] 框架根（省略 = cwd 向上找）
 * @param {string} [options.product] 指定产品（省略 = 有脚本的产品里挑第一个）
 * @param {number} [options.hours] 阈值小时数，默认 24
 * @param {boolean} [options.all] 连"常驻文档"一起归档（默认 false，跳过没日期的活文档）
 * @param {string} [options.python] 指定解释器
 */
export function planReportGc(options = {}) {
  const { listProducts } = options.deps ?? {}
  const start = path.resolve(options.root ?? process.cwd())
  const found = findFrameworkRoot(start)
  const notes = []
  const warnings = []

  if (!found?.root) {
    return {
      ok: false,
      failure: `从 \`${start}\` 往上没找到框架根（认 \`.dsh-test-framework.json\` 或「AGENTS.md + _templates」）——`
        + '请在框架根目录下、或用 root 参数指定框架根再跑。',
      notes, warnings,
    }
  }
  const root = found.root

  if (typeof listProducts !== 'function') {
    return {
      ok: false,
      failure: '插件内部错误：listProducts 没注进来（report-gc 需要它枚举产品）。',
      notes, warnings,
    }
  }

  const cands = productsWithScript(root, { listProducts })
  if (cands.length === 0) {
    const products = listProducts(root)
    return {
      ok: false,
      root,
      failure: `框架根 \`${root}\` 下没有任何产品放了归档脚本 \`<产品>\\${BUBBLE_DIR}\\${ARCHIVE_SCRIPT}\`。\n`
        + `（产品：${products.length ? products.join('、') : '（一个都没有）'}）\n`
        + '处置：① 新的框架直接跑 `test_framework_init`，插件会把规范版脚本放进 `_冒泡测试\\`；'
        + '② 已有框架可以把插件 `templates\\产品\\_冒泡测试\\archive_reports.py` 拷过去。',
      notes, warnings,
    }
  }

  let chosen = cands[0]
  if (options.product) {
    const hit = cands.find((c) => c.product === options.product)
    if (!hit) {
      return {
        ok: false,
        root,
        failure: `产品「${options.product}」下没有归档脚本。有脚本的产品：${cands.map((c) => c.product).join('、')}。`,
        notes, warnings,
      }
    }
    chosen = hit
  } else if (cands.length > 1) {
    notes.push(
      `有 ${cands.length} 个产品都放了脚本（${cands.map((c) => c.product).join('、')}），`
      + `本次用「${chosen.product}」那份 —— 脚本会遍历**所有**产品，效果一样。`,
    )
  }

  const hours = Number.isFinite(options.hours) && options.hours > 0 ? Math.floor(options.hours) : DEFAULT_HOURS
  const dryRun = options.dryRun !== false
  const argv = [chosen.script, '--hours', String(hours)]
  if (options.all === true) argv.push('--all')
  if (dryRun) argv.push('--dry-run')

  const python = options.python
    ? { command: options.python, tried: [], version: undefined }
    : findPython()
  if (!python) {
    warnings.push(
      `没找到 python 解释器（试过 ${PYTHON_CANDIDATES.join(' / ')}）—— 归档脚本跑不了。`
      + '请装 Python 或用 `python` 参数指定解释器绝对路径。',
    )
  }

  return {
    ok: Boolean(python),
    root,
    product: chosen.product,
    script: chosen.script,
    python,
    argv,
    hours,
    all: options.all === true,
    dryRun,
    archiveRoot: path.join(root, ARCHIVE_ROOT_REL),
    notes, warnings,
    failure: python ? undefined : warnings[warnings.length - 1],
  }
}

/**
 * 执行报告回收。`plan.dryRun` 为 true 时脚本只打印会动什么、**不搬任何文件**。
 *
 * @returns {{ok: boolean, status: number|null, output: string, inherited: boolean, note?: string, plan: object, failure?: string}}
 */
export function runReportGc(options = {}) {
  const plan = options.plan ?? planReportGc(options)
  if (!plan.ok || !plan.python) {
    return { ok: false, status: null, output: '', inherited: false, plan, failure: plan.failure ?? '规划失败' }
  }
  const timeoutMs = options.timeoutMs ?? 120000
  const r = runCapture(plan.python.command, plan.argv, {
    timeout: timeoutMs,
    cwd: path.dirname(plan.script),
  })
  const ok = r.status === 0 && !r.error
  return {
    ok,
    status: r.status,
    output: r.combined ?? '',
    inherited: r.inherited === true,
    note: r.note,
    plan,
    failure: ok ? undefined : (r.error ? String(r.error.message ?? r.error) : `脚本退出码 ${r.status}`),
  }
}

/** 把回收结果渲染成人看得懂的一段话。 */
export function renderReportGc(result) {
  const p = result.plan ?? {}
  const lines = []
  lines.push(result.ok ? '# 报告回收 ✅' : '# 报告回收 ❌')
  if (p.root) lines.push(`- 框架根：\`${p.root}\``)
  if (p.script) lines.push(`- 归档脚本：\`${p.script}\``)
  if (p.python) lines.push(`- 解释器：\`${p.python.command}${p.python.version ? ` (Python ${p.python.version})` : ''}\``)
  if (p.archiveRoot) lines.push(`- 归档区：\`${p.archiveRoot}\``)
  if (p.hours) {
    lines.push(`- 阈值：**${p.hours} 小时**（修改时间早于它的报告被归档）`
      + `${p.all ? '，**含常驻文档（--all）**' : '；没日期的常驻文档已跳过'}`)
  }
  if (p.dryRun) {
    lines.push('- 模式：**预演（dry-run）** —— 一个文件都没动。要真归档，再调一次并传 `dryRun: false`。')
  }

  for (const n of p.notes ?? []) lines.push(`- 提示：${n}`)
  for (const w of p.warnings ?? []) lines.push(`- ⚠️ ${w}`)

  if (result.failure) {
    lines.push('', `**失败**：${result.failure}`)
    if (p.failure && p.failure !== result.failure) lines.push('', p.failure)
  }

  if (result.inherited) {
    lines.push('', '> 受限沙箱下拿不到子进程输出（禁止命名管道），脚本输出**已直接打进终端**，这里只拿到退出码'
      + `${result.note ? `（${result.note}）` : ''}。要看明细请在上面的终端输出里看，或改用 CLI：`
      + '`node lib\\cli.js report-gc`。')
  } else if (result.output) {
    lines.push('', '## 脚本输出', '```text', result.output, '```')
  }

  return lines.join('\n')
}
