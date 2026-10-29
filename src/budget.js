/**
 * 提示词预算（prompt budget）预检 —— 防止工作区契约越写越长、被 DSH **静默截断**。
 *
 * ## 为什么要这个模块
 *
 * DSH 的 `workspace-instructions` 把工作区指令文件（框架根 `AGENTS.md`，以及
 * `$DSH_HOME/AGENTS.md` 这个用户级文件）渲染成**一条基线消息**注入上下文，`maxBytes`
 * 默认 **65536**（`dsh-base` 里没有覆盖它）。超预算时的顺序是：
 *
 *   1. **先丢范围更宽的文件**（用户级 → 项目级）；
 *   2. **再截断最具体的那份**（本项目就是 `AGENTS.md`）；
 *   3. 并在正文最前面插一句
 *      `Workspace instruction budget 65536 bytes: truncated AGENTS.md from … to … bytes`。
 *
 * 结果就是：**契约尾巴被悄悄砍掉，而模型不知道自己少读了什么**。所以把 DSH 的渲染
 * 口径**按字节复算一遍**，在写进 `AGENTS.md` 之前就报警。
 *
 * ## 复算口径（照抄 DSH 实现，不是估算）
 *
 * `@deepseek-ai/dsh-agent-instructions` 的 `buildInstructionText()`：
 *
 *   "<system-reminder>" + "\n"
 *   + intro + "\n\n" + Σ section        // 多份文件以 "\n\n" 连接
 *   + "\n" + "</system-reminder>"
 *
 *   intro   = 下面 INTRO 那段固定前言
 *   section = "Instructions from: <displayPath>" + "\n\n" + <文件正文>
 *   （正文里的 `</system-reminder>` 会被转义成 `<\/system-reminder>`，多出的字节也算）
 *
 * **实测校对**：本框架 2026-10-22 真撞上过 —— `AGENTS.md` 65494 字节时被截断到 65143。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH `workspace-instructions` 的 `maxBytes` 默认值。 */
export const PROMPT_BUDGET_BYTES = 65536
/** 余量警戒线：剩不到这么多字节就报「告急」（够容纳一两段 + 截断提示语）。 */
export const PROMPT_BUDGET_RESERVE = 1024

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence '
  + 'over broader ones. They do not override system, developer, or direct user '
  + 'instructions.'

export const LEVEL_OK = 'ok'
export const LEVEL_TIGHT = 'tight'
export const LEVEL_OVER = 'over'

/** 一份文件在基线消息里的段落文本（DSH 的 `sectionText`）。 */
export function sectionText(displayPath, content) {
  return `Instructions from: ${displayPath}\n\n${content}`
}

/** DSH 渲染后的完整基线消息（用于精确量字节，别拿它整段打印）。 */
export function renderInstructions(files) {
  const blocks = [INTRO, ...files.map((f) => sectionText(f.displayPath, f.content))]
  const body = blocks
    .filter((b) => b.length > 0)
    .join('\n\n')
    .replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
  return `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`
}

/**
 * 复算「渲染后」字节数并给出结论。
 * @param {{displayPath: string, content: string, path?: string}[]} files
 * @param {{maxBytes?: number, reserve?: number}} [options]
 */
export function measurePromptBudget(files, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : PROMPT_BUDGET_BYTES
  const reserve = Number.isFinite(options.reserve) ? options.reserve : PROMPT_BUDGET_RESERVE
  const rendered = renderInstructions(files)
  const used = Buffer.byteLength(rendered, 'utf8')
  const contentBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0)
  const headroom = maxBytes - used

  let level = LEVEL_OK
  if (used > maxBytes) level = LEVEL_OVER
  else if (headroom < reserve) level = LEVEL_TIGHT

  return {
    maxBytes,
    reserve,
    used,
    headroom,
    ratio: maxBytes ? Number((used / maxBytes).toFixed(4)) : null,
    overhead: used - contentBytes,
    level,
    files: files.map((f) => ({
      displayPath: f.displayPath,
      path: f.path ?? null,
      bytes: Buffer.byteLength(f.content, 'utf8'),
    })),
  }
}

/** DSH_HOME（默认 `%USERPROFILE%\.dsh`）。 */
export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 收集**会同一条基线消息里出现**的指令文件：用户级 + 框架根。
 * 两份都算在一个 `maxBytes` 里 —— 这正是"用户级文件也会吃掉预算"的原因。
 */
export function collectInstructionFiles(root, dshHome = defaultDshHome()) {
  const files = []
  const absent = []

  const userGlobal = path.join(dshHome, 'AGENTS.md')
  if (fs.existsSync(userGlobal)) {
    files.push({
      displayPath: '~/.dsh/AGENTS.md',
      path: userGlobal,
      content: fs.readFileSync(userGlobal, 'utf8'),
    })
  } else {
    absent.push(userGlobal)
  }

  const rootAgents = path.join(root, 'AGENTS.md')
  if (!fs.existsSync(rootAgents)) {
    const err = new Error(`框架根没有 AGENTS.md：${rootAgents}`)
    err.code = 'E_NO_AGENTS_MD'
    throw err
  }
  files.push({ displayPath: 'AGENTS.md', path: rootAgents, content: fs.readFileSync(rootAgents, 'utf8') })

  return { files, absent }
}

/** 一步到位：量某个框架根的提示词预算。 */
export function checkPromptBudget({ root, dshHome, maxBytes, reserve } = {}) {
  const base = path.resolve(root ?? process.cwd())
  const home = dshHome ? path.resolve(dshHome) : defaultDshHome()
  const { files, absent } = collectInstructionFiles(base, home)
  return { ...measurePromptBudget(files, { maxBytes, reserve }), root: base, dshHome: home, absent }
}

/** 一行摘要（doctor / status / 命令行都用它，免得三处措辞不一致）。 */
export function budgetSummary(result) {
  if (!result) return ''
  const pct = Math.round((result.ratio ?? 0) * 100)
  return `AGENTS.md ${result.files.find((f) => f.displayPath === 'AGENTS.md')?.bytes ?? 0}`
    + ` + 固定开销 ${result.overhead} = 渲染后 ${result.used}/${result.maxBytes} 字节`
    + `（${pct}%，余 ${result.headroom}）`
}

/** 超预算的处置建议（单一来源，避免各处措辞漂移）。 */
export const BUDGET_FIX = '按主题把「历史沿革 / 一次性清单 / 逐条明细」剪到 '
  + '`_archive\\outputs\\<主题>-<日期>\\`，`AGENTS.md` 正文只留**一行指针**；'
  + '别为省字节删铁律/裁决规则（§零 §二 是硬骨架），也别拆成多份"都加载"'
  + '（多份文件同样计入同一条消息的预算）。'

/**
 * 会话开头要注入的那一段 —— **只在告急/超预算时才非空**（正常时不占提示词）。
 * 返回空字符串 = DSH 会把空上下文丢掉。
 */
export function renderBudgetBlock(result) {
  if (!result || result.level === LEVEL_OK) return ''
  const lines = []
  if (result.level === LEVEL_OVER) {
    lines.push(`⚠️ **提示词预算已超 ${-result.headroom} 字节 —— \`AGENTS.md\` 正在被 DSH 截断**`
      + '（会先丢宽范围文件、再砍本文件尾部，并且读到的契约**缺一段而模型不知道**）。')
  } else {
    lines.push(`⚠️ **提示词预算余量告急（< ${result.reserve} 字节警戒线）** —— 再往里加一两段，`
      + '`AGENTS.md` 就会被 DSH 截断。')
  }
  lines.push(`现状：${budgetSummary(result)}。`)
  lines.push(`处置：${BUDGET_FIX}`)
  lines.push('自查：`node <插件>\\lib\\cli.js budget`，或框架级 skill `framework-guard` 的 `check_prompt_budget.py`。')
  return lines.join('\n')
}
