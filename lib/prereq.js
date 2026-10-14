/**
 * 前置条件（外部 MCP）检查 —— **强制项**。
 *
 * 为什么单独一个文件：框架里「看着页面操作流程」是**铁律**（AGENTS.md 铁律 10）——
 * 必须用 playwright MCP 真实打开浏览器、真实点击/输入，**不许用只读 DOM / 只抓报文 /
 * 离线脚本 / 旧截图冒充**。既然**不给替代路径**，那"没配 playwright MCP"就**不是"降级运行"，
 * 而是**前置条件不满足** —— 必须在**装完/开工前**就查出来并明确告诉用户，
 * 而不是等他要求"看着我操作"时才发现工具根本不存在。
 *
 * 检测方式：读 DSH profile 的 `cordis.patch.yml`（profile 层的 MCP 服务都配在这里）。
 * 只用 node 内置模块 —— 本插件零第三方依赖是硬约束，**不引入 YAML 解析库**，
 * 用行扫描提取 `serverName` / `- id:`，再用少量特征串兜底。
 *
 * ⚠️ 措辞纪律：**查不到不等于不存在**（用户也可能用别的方式起 MCP 服务）——
 * 所以对外一律说"**未检测到**"，不说"不存在"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 外部 MCP 清单。
 *
 * `required: true` 的项**没配就不能做对应的事，且没有替代做法**（这是用户 2026-10-14 明确的口径：
 * "强制要求使用 playwright MCP"）。`required: false` 的项缺了只是少一条取证通道，写出来供对方自查。
 */
export const REQUIRED_MCP = Object.freeze([
  {
    key: 'playwright',
    required: true,
    label: 'playwright MCP（`mcp__playwright__browser_*`）',
    why: '「看着页面操作流程」必须用**真实浏览器 + 真实鼠标键盘**（AGENTS.md 铁律 10）',
    // 命中任一即算检测到（第一组看 serverName/id，第二组是兜底特征串）
    nameHints: ['playwright'],
    textHints: [/@playwright\/mcp/i, /playwright[\\/]mcp/i],
    fix: '在 profile 的 `cordis.patch.yml` 里加一个 `mcp-playwright` 服务（`serverName: playwright`，'
      + '命令用 `@playwright/mcp`），并配成**有头**（去掉 `--headless`）—— 否则"看着"是假的。',
  },
  {
    key: 'keyword',
    required: false,
    label: '`keyword_mcp`（接口报文落盘 / toast 历史）',
    why: '纯**取证**通道 —— 抓报文、读 toast 历史（与 playwright **互补不替代**）',
    nameHints: ['keyword'],
    textHints: [/keyword_mcp/i, /fulllink_mcp/i, /kw_spec_client/i],
    fix: '在 profile 的 `cordis.patch.yml` 里配 `keyword_mcp` 服务。',
  },
  {
    key: 'cr69',
    required: false,
    label: '`cr69_mcp`（Chromium 69 老内核）',
    why: '小视口/老内核**兼容性**验证（不是主路径）',
    nameHints: ['cr69'],
    textHints: [/cr69_mcp/i, /cr69_mcp_server/i],
    fix: '在 profile 的 `cordis.patch.yml` 里配 `cr69_mcp` 服务。',
  },
])

/** 默认 `$DSH_HOME`。与 install.js 保持同一口径（这里复制一份，避免模块间循环 import）。 */
export function defaultDshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** profile 目录下的 `cordis.patch.yml` 路径。 */
export function patchFileOf(dshHome, profile) {
  return path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
}

/** 列出所有 profile 名（`<dshHome>\profiles\<名字>\package.json` 存在才算）。 */
export function listProfileNames(dshHome = defaultDshHome()) {
  const root = path.join(dshHome, 'profiles')
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'package.json')))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 从一个 profile 的 `cordis.patch.yml` 里抽出 MCP 服务名。
 *
 * 只看两类行（`serverName:` 与 `- id:`），再加特征串兜底 —— 足够稳，且不需要 YAML 解析。
 */
export function detectProfileMcp({ dshHome = defaultDshHome(), profile } = {}) {
  const file = patchFileOf(dshHome, profile)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { profile, file, exists: false, serverNames: [], ids: [], text: '' }
  }
  const serverNames = []
  const ids = []
  for (const raw of text.split(/\r?\n/)) {
    const name = /^\s*serverName:\s*['"]?([A-Za-z0-9_.:@/-]+)/.exec(raw)
    if (name) serverNames.push(name[1])
    const id = /^\s*-\s*id:\s*['"]?([A-Za-z0-9_.:@/-]+)/.exec(raw)
    if (id) ids.push(id[1])
  }
  return { profile, file, exists: true, serverNames, ids, text }
}

/** 某个 MCP 规格在某个 profile 里是否被检测到。 */
export function mcpMatches(spec, detected) {
  if (!detected?.exists) return false
  const names = [...detected.serverNames, ...detected.ids]
  if (names.some((n) => spec.nameHints.some((h) => n.toLowerCase().includes(h)))) return true
  return spec.textHints.some((re) => re.test(detected.text))
}

/**
 * 检查全部前置条件。
 *
 * 返回 `{ active, profiles, items }`：
 * - `items[].found` —— `true` 检测到 / `false` **未检测到** / `undefined` **无法判定**
 *   （连 `cordis.patch.yml` 都没找到时**不下否定结论**）。
 * - `items[].inActiveProfile` —— 当前 profile 里有没有（profile 层**不共享**，
 *   "web 配了、desktop 没配"是真实会踩的坑）。
 */
export function checkPrerequisites({ dshHome = defaultDshHome(), profile } = {}) {
  const active = profile ?? process.env.DSH_PROFILE ?? null
  const all = listProfileNames(dshHome)
  const targets = all.length ? all : (active ? [active] : [])
  const detected = targets.map((name) => detectProfileMcp({ dshHome, profile: name }))
  const anyExists = detected.some((d) => d.exists)

  const items = REQUIRED_MCP.map((spec) => {
    const hits = detected.filter((d) => mcpMatches(spec, d))
    return {
      key: spec.key,
      label: spec.label,
      why: spec.why,
      fix: spec.fix,
      required: spec.required,
      found: anyExists ? hits.length > 0 : undefined,
      inActiveProfile: anyExists && active ? hits.some((h) => h.profile === active) : (anyExists ? hits.length > 0 : undefined),
      where: hits.map((h) => h.profile),
    }
  })
  return { active, profiles: targets, items, anyExists, dshHome }
}

/** 未满足的**强制**项（`found === false`，或无法判定时也算"待确认"）。 */
export function unmetRequired(result) {
  if (!result) return []
  return result.items.filter((i) => i.required && i.found !== true)
}

/**
 * 渲染前置条件提示（Markdown）。
 *
 * 全部满足 → 返回 `''`（不占 token）。**强制项没满足时一定非空** ——
 * 这是 renderGate 不能因为"登记没问题"就整段跳过的原因。
 */
export function renderPrereqBlock(result) {
  if (!result) return ''
  const unmet = result.items.filter((i) => i.required && i.found === false)
  const unknown = result.items.filter((i) => i.required && i.found === undefined)
  const optionalMissing = result.items.filter((i) => !i.required && i.found === false)
  // ⚠️ 可选 MCP 只在"**必需项**也有问题"时顺带提一句。
  // 否则"配了 playwright 但没配 cr69"的人会**每个会话**都看到一行提示 —— 那是纯噪音，
  // 而可选项目的本来就不该拦人（要看的话 `doctor` 里一直列着）。
  if (unmet.length === 0 && unknown.length === 0) return ''

  const lines = []
  for (const item of unmet) {
    lines.push(`⚠️ **前置条件未满足：未检测到 ${item.label}（必需）**`)
    lines.push(`- 影响：${item.why} —— **没有替代路径**（不许用只读 DOM / 只抓报文 / 离线脚本 / 旧截图冒充）。`)
    lines.push(`- 处置：**先让用户配好再开工**，不要"先测着看"。${item.fix}`)
    lines.push(`- 配置位置：\`${patchFileOf(result.dshHome, item.where[0] ?? result.active ?? '<profile>')}\`（profile 层，**改完必须重启 DSH**）。`)
    if (item.where.length === 0 && result.anyExists && result.active) {
      lines.push(`- 注意：**profile 层不共享** —— 其它 profile 里配了，当前 profile「${result.active}」里也没有等于没配。`)
    }
    lines.push('- 自查：`node _plugin\\dsh-test-framework\\lib\\cli.js doctor`')
  }
  for (const item of unknown) {
    lines.push(`❔ **${item.label} 无法判定**：没找到 profile 的 \`cordis.patch.yml\`，`
      + '**不敢下"没配"的结论** —— 请让用户确认这个 MCP 到底有没有。')
  }
  for (const item of optionalMissing) {
    lines.push(`ℹ️ 未检测到 ${item.label}（非必需，缺了少一条取证通道）。${item.fix}`)
  }
  return lines.join('\n')
}
