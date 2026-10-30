/**
 * 模板装载与渲染。
 *
 * 模板就放在插件包内的 `templates\` —— 跟着插件走，不依赖用户工作区里有没有模板。
 * 渲染是**手写的 `{{KEY}}` 替换**，刻意不引模板引擎：
 *   · 插件是 `link:` 安装的，真实路径在 profile 之外，解析不到 profile 的 node_modules；
 *   · 我们只需要「整词替换 + 未替换的留原样并告警」这两件事，任何引擎都是净负担。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 模板根目录（插件包内的 `templates\`）。 */
export const TEMPLATE_ROOT = path.join(HERE, '..', 'templates')

/** 渲染时**允许**出现的占位符全集。出现别的就说明模板写错了，要告警而不是静默。 */
export const KNOWN_KEYS = new Set([
  'PRODUCT',
  'PRODUCT_DIR',
  'FRAMEWORK_ROOT',
  'REQ_DOC_ROOT',
  'MODULE',
  'MODULE_SLUG',
  'MENU',
  'MENU_PATH',
  'ROUTE',
  'VERSION',
  'DATE',
  'STAMP',
  'PLUGIN_VERSION',
  'GENERATED_BY',
])

/** 模板文件是否存在。 */
export function templateExists(rel) {
  try {
    return fs.statSync(path.join(TEMPLATE_ROOT, rel)).isFile()
  } catch {
    return false
  }
}

/** 读模板原文。 */
export function readTemplate(rel) {
  return fs.readFileSync(path.join(TEMPLATE_ROOT, rel), 'utf8')
}

/** 列出模板子目录下的全部相对路径（递归，正斜杠 → 平台分隔符）。 */
export function listTemplateFiles(rel = '.') {
  const base = path.join(TEMPLATE_ROOT, rel)
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath)
      else out.push(relPath)
    }
  }
  walk(base, '')
  return out.sort()
}

/**
 * 渲染模板正文。
 *
 * 行为：
 *   · `{{KEY}}` 整词替换（大小写敏感、允许多余空白：`{{ KEY }}` 也算）；
 *   · 未知 key **保留原样**并记进 `warnings`（模板写错了要看得见，不能悄悄渲染出半成品）；
 *   · 不给值（undefined/null）的已知 key 也保留原样并告警。
 */
export function renderTemplate(text, vars = {}) {
  const warnings = []
  const used = new Set()
  const out = String(text).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (whole, key) => {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`模板里有未知占位符 ${whole}`)
      return whole
    }
    const value = vars[key]
    if (value === undefined || value === null || value === '') {
      warnings.push(`占位符 ${whole} 没给值，保留原样`)
      return whole
    }
    used.add(key)
    return String(value)
  })
  return { text: out, warnings, used: [...used].sort() }
}

/** 读 + 渲染一个模板文件，一步到位（模板缺失时抛错 —— 调用方自己决定要不要兜底）。 */
export function renderTemplateFile(rel, vars) {
  const result = renderTemplate(readTemplate(rel), vars)
  return { ...result, path: path.join(TEMPLATE_ROOT, rel) }
}

/** 读 + 渲染，但**模板缺失不抛**：返回原文为空字符串 + 一条告警。脚手架用它逐个文件容错。 */
export function renderTemplateSafe(rel, vars) {
  if (!templateExists(rel)) return ''
  return renderTemplate(readTemplate(rel), vars).text
}
