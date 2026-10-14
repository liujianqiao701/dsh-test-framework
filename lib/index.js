/**
 * dsh-test-framework —— cordis 宿主侧入口。
 *
 * 本插件为「测试工作框架」提供三件事：
 *   ① **6 个工具**：初始化骨架 / 查状态 / 增模块（含按版本建规范）/ 登记产品级规范 / 探需求文档 / 报告回收；
 *   ② **4 个 runtime skill**：总契约 + 初始化 + **新需求文档强制引导流程** + 增模块；
 *   ③ **一段系统提示词**：把「框架登记还缺什么」实时摆到模型面前 —— 这是"拦得住人"的关键，
 *      因为产品级/模块级规范不会被自动加载，光靠 AGENTS.md 拦不住。
 *
 * ⚠️ 全篇**零静态 `@deepseek-ai/*` import**：本插件常以 `link:` 安装，真实路径在 profile 之外，
 *    Node 解析不到 profile 的 `node_modules\@deepseek-ai\*`。因此一律走 `serviceOf(ctx, name)` 可选取服务 +
 *    `pickMethod()` 探测方法名，并在每段注册外面包 try/catch —— **插件绝不能把 DSH 启动搞挂**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILLS } from './skills.js'
import { TOOLS, setPluginVersion, cwdOf } from './tools.js'
import { frameworkStatus, renderGate, setReqDocRoot } from './framework.js'

export const name = 'dsh-test-framework'
/** 硬依赖为空：拿不到任何服务时静默降级，不影响 DSH 启动。 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_SECTION = 'dsh-test-framework'
/** 提示词段落顺序：900 = 靠后，不插进别的段落中间。 */
const PROMPT_ORDER = 900
/** 状态缓存时长：系统提示词每次组装都会求值，不能每次都扫盘。 */
const STATUS_CACHE_MS = 5000

/** 读插件自己的版本（工具输出里带上，便于排查"装的是哪一版"）。 */
function readOwnVersion() {
  try {
    const raw = fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')
    return JSON.parse(raw).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 可选取一个 cordis 服务。拿不到返回 undefined，**不抛**。
 * 不声明 `inject` 的插件只能用这种方式取服务（声明了就得等它出现，否则 apply 不执行）。
 */
function serviceOf(ctx, serviceName) {
  for (const getter of [
    () => ctx?.get?.(serviceName),
    () => ctx?.[serviceName],
    () => ctx?.root?.[serviceName],
  ]) {
    try {
      const value = getter()
      if (value !== undefined && value !== null) return value
    } catch {
      /* 换下一个位置找 */
    }
  }
  return undefined
}

/** 在目标对象上按候选名找第一个可调用方法，返回 `{ fn, via, target }`。 */
function pickMethod(target, names) {
  if (target === undefined || target === null) return undefined
  for (const n of names) {
    try {
      const fn = target[n]
      if (typeof fn === 'function') return { fn: fn.bind(target), via: n }
    } catch {
      /* 属性访问本身可能抛（getter），跳过 */
    }
  }
  return undefined
}

/** 统一的降级日志：只在 stderr 上说一句，不影响任何流程。 */
function warn(message) {
  try {
    process.stderr.write(`dsh-test-framework: ${message}\n`)
  } catch {
    /* stderr 都写不了就算了 */
  }
}

/** 短错误信息。 */
function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// ① skill 注册
// ---------------------------------------------------------------------------

function registerSkills(ctx) {
  const skills = serviceOf(ctx, 'skills')
  const register = pickMethod(skills, ['register'])
  if (register === undefined) {
    warn(`当前 dsh 没有可用的 skills 服务（试过 ctx.get('skills') / ctx.skills / ctx.root.skills），`
      + '跳过 4 个 runtime skill 的注册。工具与提示词不受影响；'
      + '你仍可把 skill 正文抄到工作区的 skills\\ 目录里用。')
    return
  }
  let ok = 0
  for (const skill of SKILLS) {
    try {
      register.fn({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        content: skill.content,
        // source 标成 runtime：rank 250，**项目级 skill（rank 100）会覆盖它** ——
        // 用户在 skills\<同名>\SKILL.md 写自己的版本永远优先，插件不抢。
        source: 'runtime',
      })
      ok += 1
    } catch (error) {
      warn(`注册 skill「${skill.name}」失败（已跳过）—— ${msgOf(error)}`)
    }
  }
  if (ok > 0) {
    try {
      process.stderr.write(`dsh-test-framework: 已注册 ${ok}/${SKILLS.length} 个 runtime skill`
        + `（${SKILLS.map((s) => s.name).join(', ')}）。同名项目级 skill 会覆盖它们。\n`)
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// ② 工具注册
// ---------------------------------------------------------------------------

/** `tools.register` 的历史方法名（不同 dsh 版本可能不同）。 */
const TOOL_REGISTER_METHODS = ['register', 'defineTool', 'define', 'add']

function registerTools(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const register = pickMethod(tools, TOOL_REGISTER_METHODS)
  if (register === undefined) {
    warn(`当前 dsh 的 tools 服务没有可用的注册方法（试过 ${TOOL_REGISTER_METHODS.join('/')}），`
      + `跳过 ${TOOLS.length} 个工具的注册。skill 与提示词不受影响。`)
    return
  }
  let ok = 0
  for (const tool of TOOLS) {
    try {
      register.fn(tool)
      ok += 1
    } catch (error) {
      warn(`注册工具「${tool.name}」失败（已跳过）—— ${msgOf(error)}`)
    }
  }
  if (ok > 0) {
    try {
      process.stderr.write(`dsh-test-framework: 已注册 ${ok}/${TOOLS.length} 个工具`
        + `（${TOOLS.map((t) => t.name).join(', ')}）。\n`)
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// ③ 系统提示词：把「框架登记还缺什么」摆到模型面前
// ---------------------------------------------------------------------------

/** 状态缓存：key = 工作目录。避免每次组装提示词都扫盘。 */
const statusCache = new Map()

function cachedGate(cwd) {
  const now = Date.now()
  const hit = statusCache.get(cwd)
  if (hit && now - hit.at < STATUS_CACHE_MS) return hit.text
  let text = ''
  try {
    text = renderGate(frameworkStatus({ root: cwd }))
  } catch (error) {
    // 提示词段落绝不能因为扫盘失败而中断
    warn(`计算框架状态失败（本次不注入提示词）—— ${msgOf(error)}`)
    text = ''
  }
  // 防止工作目录种类无限增长
  if (statusCache.size > 64) statusCache.clear()
  statusCache.set(cwd, { at: now, text })
  return text
}

/**
 * 渲染时要防的一件事：`renderPrompt` 对 `{{...}}` 是**严格模式**，未知变量会抛错。
 * 我们注入的正文里可能带上用户填的文档名/环境名，所以先把 `{{` 打断。
 */
function neutralizeBraces(text) {
  return String(text).replace(/\{\{/g, '{ {')
}

function registerPromptSection(ctx) {
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  const section = pickMethod(systemPrompt, ['section'])
  if (section === undefined) {
    warn(`当前 dsh 没有可用的 systemPrompt 服务（试过 ctx.get('systemPrompt') / ctx.systemPrompt），`
      + '跳过「框架登记闸门」提示词段落。工具与 skill 不受影响 —— '
      + '此时请让模型**主动调** `test_framework_status` 来看登记状态。')
    return
  }
  try {
    section.fn({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: (context) => {
        try {
          // AssembleContext 上的 agent 由 dsh-agent 声明合并进来；拿不到就退回进程 cwd
          const cwd = context?.agent ? cwdOf({ agent: context.agent }) : process.cwd()
          return neutralizeBraces(cachedGate(cwd))
        } catch {
          return ''
        }
      },
    })
    process.stderr.write('dsh-test-framework: 已注册系统提示词段落（框架登记闸门）。\n')
  } catch (error) {
    warn(`注册系统提示词段落失败（已跳过）—— ${msgOf(error)}`)
  }
}

// ---------------------------------------------------------------------------
// ④ 斜杠命令：给人用的，不进模型历史
// ---------------------------------------------------------------------------

function registerCommands(ctx) {
  const commands = serviceOf(ctx, 'commands')
  const register = pickMethod(commands, ['register'])
  if (register === undefined) {
    // 命令是「顺带提供」的人机便利，拿不到就**安静跳过**，不为它刷日志
    return
  }
  const defs = [
    {
      name: 'tf-status',
      description: '查看测试框架登记状态（等价于 test_framework_status 工具，但不消耗模型回合）',
      run: () => {
        const status = frameworkStatus({ root: process.cwd() })
        return renderGate(status) || `测试框架状态正常，无待补项。\n框架根：${status.frameworkRoot ?? '（未识别）'}`
      },
    },
    {
      name: 'tf-gate',
      description: '只看「还缺哪些登记项」这一份清单（版本 / 拆分 / 跨文档关联 / 环境账密 / 模块）',
      run: () => {
        const status = frameworkStatus({ root: process.cwd() })
        if (!status.frameworkRoot) return '当前工作区还没有初始化测试框架 —— 用 test_framework_init 搭骨架。'
        const lines = []
        for (const p of status.products) {
          lines.push(`【${p.name}】${p.ready ? '✅ 可以开测' : '❌ 还缺：'}`)
          for (const m of p.missing) lines.push(`  · ${m.ask}`)
        }
        return lines.join('\n') || '（没有产品）'
      },
    },
  ]
  for (const def of defs) {
    try {
      register.fn({
        name: def.name,
        description: def.description,
        handler: () => {
          try {
            return { kind: 'success', text: def.run() }
          } catch (error) {
            return { kind: 'error', text: `dsh-test-framework: ${msgOf(error)}` }
          }
        },
      })
    } catch (error) {
      warn(`注册命令 /${def.name} 失败（已跳过）—— ${msgOf(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  setPluginVersion(config?.pluginVersion ?? readOwnVersion())
  // 需求文档总根目录由使用者在 profile 的 cordis.patch.yml 里给（config.reqDocRoot），
  // 或环境变量 DSH_REQ_DOC_ROOT；都没给就兜底 `<用户主目录>\需求业务文档`。
  // **不在代码里写死绝对路径** —— 这包是发给别人用的。
  setReqDocRoot(config?.reqDocRoot)


  const steps = [
    ['skill', registerSkills],
    ['工具', registerTools],
    ['提示词段落', registerPromptSection],
    ['命令', registerCommands],
  ]
  for (const [label, fn] of steps) {
    try {
      fn(ctx)
    } catch (error) {
      // 任何一步炸了都不能影响 DSH 启动 —— 只记日志，继续跑后面的
      warn(`注册${label}时发生未捕获异常（已忽略）—— ${msgOf(error)}`)
    }
  }
}

export { frameworkStatus, renderGate, SKILLS, TOOLS }
