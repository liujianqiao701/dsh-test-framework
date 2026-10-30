/**
 * 需求文档探针：**零依赖**读 docx（zip 自己解、XML 自己扒），用来支撑「要不要拆模块」的判定。
 *
 * 为什么要自己写：
 *   · 插件不允许有第三方依赖（`link:` 安装时解析不到 profile 的 node_modules）；
 *   · 需求文档动辄 100+ 页，模型不可能整篇读进来 —— 必须先出**结构摘要**（页数 / 章节树 / 图片数 / 划掉项），
 *     再由人（用户）确认拆分方案。
 *
 * 边界（照实说，不许含糊）：
 *   · **加密 docx 读不了** —— 本机加密件是 OLE 容器，解密要 msoffcrypto（Python）。
 *     探针会认出加密并给出「用框架级 skill `requirement-docs` 解密」的处置，**不会假装读到了内容**。
 *   · 二进制老格式 `.doc`（非 zip）也读不了，同样如实上报。
 *   · 页数优先取 `docProps/app.xml` 的 `<Pages>`（Word 自己写的）；取不到就**估算**并标明 `estimated: true`。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_EOCD = 0x06054b50
const ZIP_CD = 0x02014b50

/** 判定一个文件是不是 OLE 复合文档（加密 docx 与老 .doc 都是它）。 */
export function isOle(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC)
}

/** 判定一个文件是不是 zip（docx/xlsx 都是 zip）。 */
export function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
}

/**
 * 扫 ZIP 中央目录。
 * @returns {Map<string, {method:number, offset:number, compSize:number, uncompSize:number}>}
 */
export function readZipDirectory(buf) {
  // 从尾部往前找 EOCD（注释最长 65535，故最多回退 65557 字节）
  const maxBack = Math.min(buf.length, 65557 + 22)
  let eocd = -1
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CD) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method, offset, compSize, uncompSize })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 从 zip 里取一个条目的内容（stored / deflate 两种压缩方式）。 */
export function readZipEntry(buf, entries, name) {
  const entry = entries.get(name)
  if (!entry) return undefined
  const lh = entry.offset
  if (buf.readUInt32LE(lh) !== 0x04034b50) return undefined
  const nameLen = buf.readUInt16LE(lh + 26)
  const extraLen = buf.readUInt16LE(lh + 28)
  const start = lh + 30 + nameLen + extraLen
  // 优先用中央目录里的长度（本地头在流式写出时可能是 0，真正的长度在 data descriptor 里）
  const size = entry.compSize || buf.readUInt32LE(lh + 18)
  const raw = buf.subarray(start, start + size)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// XML 小工具
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** 还原 XML 实体。 */
export function decodeXml(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** 取一个标签在 XML 里的属性值（只取第一个匹配）。 */
function attrOf(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'i')
  const m = re.exec(xml)
  return m ? m[1] : undefined
}

/** 把 XML 里的所有 `<w:t>` 文本抠出来拼成一段纯文本（去标签时按段落分隔符补换行）。 */
function textOf(xml) {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:(?:cr)\b[^>]*\/>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out += decodeXml(m[1])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else out += ' '
  }
  return out
}

// ---------------------------------------------------------------------------
// 段落 / 章节抽取
// ---------------------------------------------------------------------------

/** 章节词尾：带这些词的标题基本是"章节"而不是"功能"，拆分判据要把它们排除。 */
const SECTION_WORDS = [
  '概述', '说明', '背景', '目的', '范围', '流程', '规则', '权限', '字段', '接口', '表结构',
  '非功能', '术语', '附录', '修订', '目录', '方案', '需求', '设计', '总述', '简介', '约束', '验收',
]

const PAGE_BREAK = /<w:br\b[^>]*w:type="page"|<w:lastRenderedPageBreak\b/g

/**
 * 把 `word/document.xml` 拆成段落级结构。
 * @returns {{paragraphs: Array, pageBreaks: number, tables: number, images: number, strikes: number}}
 */
export function parseDocumentXml(xml) {
  const paragraphs = []
  // 段落切分：<w:p ...>…</w:p> 与自闭合 <w:p/>
  const paraRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g
  let m
  while ((m = paraRe.exec(xml)) !== null) {
    const body = m[1] ?? ''
    const text = textOf(body).replace(/\s+/g, ' ').trim()
    const style = (attrOf(body, 'w:pStyle', 'w:val') ?? '').trim()
    const outlineRaw = attrOf(body, 'w:outlineLvl', 'w:val')
    let level = 0
    if (outlineRaw !== undefined && /^\d+$/.test(outlineRaw)) level = Number(outlineRaw) + 1
    if (level === 0 && style) {
      const h = /^(?:Heading|heading|标题)\s*([1-9])$/.exec(style.replace(/[-_]/g, ' '))
      if (h) level = Number(h[1])
      else if (/^[1-9]$/.test(style)) level = Number(style)
    }
    const strike =
      /<w:strike\b(?![^>]*w:val="(?:false|0|off|no)")/.test(body)
      || /<w:dstrike\b(?![^>]*w:val="(?:false|0|off|no)")/.test(body)
      || /<w:del\b/.test(body)
      || /<w:delText\b/.test(body)
    const images = (body.match(/<w:drawing\b|<w:pict\b|<w:object\b/g) ?? []).length
    paragraphs.push({ text, style, level, strike, images, empty: text === '' })
  }
  return {
    paragraphs,
    pageBreaks: (xml.match(PAGE_BREAK) ?? []).length,
    tables: (xml.match(/<w:tbl\b/g) ?? []).length,
    images: (xml.match(/<w:drawing\b|<w:pict\b|<w:object\b/g) ?? []).length,
    strikes: paragraphs.filter((p) => p.strike).length,
  }
}

/** 中文/英文混排的页数估算：按正文字符数 / 每页 1800 字（需求文档正文密排时的常用量级）。 */
function estimatePages(chars, pageBreaks) {
  return Math.max(pageBreaks, Math.ceil(chars / 1800))
}

/** 「疑似功能名」启发式：短、且不含章节词。 */
function looksLikeFeatureTitle(title) {
  const t = title.trim()
  if (!t || t.length > 22) return false
  if (SECTION_WORDS.some((w) => t.includes(w))) return false
  if (/^[（(]?\d+[）)]?$/.test(t)) return false
  return true
}

/**
 * 探一份需求文档。
 *
 * @param {string} file 文档绝对路径
 * @param {object} [options]
 * @param {string[]} [options.knownMenus] 已知顶级菜单名（从产品级 `模块路由.md` 读来）—— 命中即强判据
 * @param {number} [options.pageThreshold] 页数阈值，默认 100
 * @param {number} [options.maxHeadings] 返回的章节树上限，默认 120
 * @param {number} [options.maxChars] 统计正文时最多解析多少字符（防超大文档卡住），0 = 不限制
 */
export function probeDocx(file, options = {}) {
  const pageThreshold = options.pageThreshold ?? 100
  const maxHeadings = options.maxHeadings ?? 120
  const knownMenus = (options.knownMenus ?? []).filter(Boolean)
  const report = {
    file,
    exists: false,
    kind: 'unknown',
    parsable: false,
    warnings: [],
    pages: null,
    pagesEstimated: false,
    words: null,
    characters: null,
    paragraphs: null,
    tables: null,
    images: null,
    strikethroughParagraphs: null,
    headings: [],
    suspectedModules: [],
    menuHits: [],
    splitAdvice: { mustAsk: false, level: 'unknown', reasons: [] },
  }

  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (error) {
    report.warnings.push(`读不到文件：${error.message}`)
    return report
  }
  report.exists = true
  report.bytes = buf.length

  if (isOle(buf)) {
    const ext = path.extname(file).toLowerCase()
    report.kind = ext === '.doc' ? 'ole-doc' : 'ole-encrypted'
    report.parsable = false
    report.warnings.push(
      report.kind === 'ole-encrypted'
        ? '这是 **OLE 容器（加密文档）**，解析不了。处置：用框架级 skill `requirement-docs` 解密后再探 —— '
          + `\`python skills\\requirement-docs\\scripts\\prep_requirement.py --src "<文件>" --password <密码> --module <模块>\` `
          + '（密码见产品级规范 `_框架配置\\环境与账密.md`；**不要**把密码写进脚本）。'
        : '这是**二进制老格式 `.doc`**（非 zip），本探针读不了。处置：用 Word 另存为 `.docx` 再探，'
          + '或走 `requirement-docs` skill 的抽取脚本。',
    )
    report.splitAdvice.level = 'blocked'
    report.splitAdvice.reasons.push('文档解析不了 → 页数与章节数未知 → **无法判定是否需要拆分**，必须先解密/转换')
    return report
  }

  if (!isZip(buf)) {
    report.kind = 'not-office'
    report.warnings.push('既不是 OLE 也不是 ZIP —— 可能不是 Office 文档，或文件损坏/被截断。')
    report.splitAdvice.level = 'blocked'
    report.splitAdvice.reasons.push('文档格式不识别')
    return report
  }

  const ext = path.extname(file).toLowerCase()
  let entries
  try {
    entries = readZipDirectory(buf)
  } catch (error) {
    report.kind = 'bad-zip'
    report.warnings.push(`ZIP 目录解析失败：${error.message}`)
    return report
  }
  if (!entries.has('word/document.xml')) {
    report.kind = ext === '.xlsx' ? 'xlsx' : ext === '.pptx' ? 'pptx' : 'zip-not-docx'
    report.warnings.push('这是 zip，但里面没有 `word/document.xml` —— 不是 Word 文档。')
    report.splitAdvice.level = 'blocked'
    report.splitAdvice.reasons.push('不是 docx，无法做章节/页数判定')
    return report
  }
  report.kind = 'docx'

  // ---- docProps/app.xml：页数 / 字数（Word 自己算的，最准） ----
  const appXml = readZipEntry(buf, entries, 'docProps/app.xml')
  if (appXml) {
    const app = appXml.toString('utf8')
    const num = (tag) => {
      const m = new RegExp(`<${tag}>\\s*([0-9]+)\\s*</${tag}>`, 'i').exec(app)
      return m ? Number(m[1]) : null
    }
    report.pages = num('Pages')
    report.words = num('Words')
    report.characters = num('Characters')
    report.paragraphs = num('Paragraphs')
  } else {
    report.warnings.push('没有 `docProps/app.xml` —— 页数只能估算')
  }

  // ---- word/document.xml：结构 ----
  const docXml = readZipEntry(buf, entries, 'word/document.xml')
  if (!docXml) {
    report.warnings.push('读不出 `word/document.xml`（压缩方式不支持？）')
    report.splitAdvice.level = 'blocked'
    report.splitAdvice.reasons.push('文档正文读不了')
    return report
  }
  const xml = docXml.toString('utf8')
  const parsed = parseDocumentXml(xml)
  report.parsable = true
  report.pageBreaks = parsed.pageBreaks
  report.tables = parsed.tables
  report.images = parsed.images
  report.strikethroughParagraphs = parsed.strikes
  report.paragraphCount = parsed.paragraphs.length
  report.bodyChars = parsed.paragraphs.reduce((n, p) => n + p.text.length, 0)
  if (report.pages === null) {
    report.pages = estimatePages(report.bodyChars, parsed.pageBreaks)
    report.pagesEstimated = true
    report.warnings.push(`页数是**估算**的（显式分页 ${parsed.pageBreaks} 处 + 正文 ${report.bodyChars} 字 ÷ 1800/页）`)
  }

  // ---- 章节树 ----
  const headings = []
  for (const p of parsed.paragraphs) {
    if (p.level >= 1 && p.text) headings.push({ level: Math.min(p.level, 4), title: p.text })
  }
  report.headingCount = headings.length
  report.headings = headings.slice(0, maxHeadings)
  if (headings.length > maxHeadings) {
    report.warnings.push(`章节共 ${headings.length} 条，只返回前 ${maxHeadings} 条`)
  }

  // ---- 菜单名交叉匹配（最硬的拆分判据） ----
  const fullText = parsed.paragraphs.map((p) => p.text).join('\n')
  for (const menu of knownMenus) {
    if (!menu) continue
    const n = fullText.split(menu).length - 1
    if (n > 0) report.menuHits.push({ menu, count: n })
  }

  // ---- 疑似子模块：标题里看起来像"功能名"的那批 ----
  const suspected = []
  for (const h of headings) {
    if (h.level > 2) continue
    if (!looksLikeFeatureTitle(h.title)) continue
    if (!suspected.includes(h.title)) suspected.push(h.title)
  }
  report.suspectedModules = suspected.slice(0, 40)

  // ---- 拆分判定 ----
  const reasons = []
  let mustAsk = false
  const bigDoc = typeof report.pages === 'number' && report.pages > pageThreshold
  if (bigDoc) {
    mustAsk = true
    reasons.push(`页数 ${report.pages}${report.pagesEstimated ? '（估算）' : ''} > 阈值 ${pageThreshold} → 命中「大文档」判据`)
  }
  if (report.menuHits.length >= 2) {
    mustAsk = true
    reasons.push(
      `正文里出现 ${report.menuHits.length} 个已知**顶级菜单名**：`
      + report.menuHits.map((h) => `${h.menu}(${h.count}处)`).join('、')
      + ' → 一份文档横跨多个菜单，必须拆分',
    )
  }
  const secondLevel = headings.filter((h) => h.level === 2 && looksLikeFeatureTitle(h.title))
  if (secondLevel.length >= 2) {
    mustAsk = true
    reasons.push(
      `二级标题里有 ${secondLevel.length} 个疑似独立功能名：`
      + secondLevel.slice(0, 8).map((h) => h.title).join('、') + (secondLevel.length > 8 ? ' …' : ''),
    )
  }
  // 典型形态：一级标题就叫「修改点N/功能N」，每个下面是一坨独立功能
  const modPoints = headings.filter((h) => /^(?:修改点|功能点?|模块)\s*\d+/.test(h.title))
  if (modPoints.length >= 2 && report.menuHits.length === 0) {
    mustAsk = true
    reasons.push(`标题里有 ${modPoints.length} 个「修改点/功能点N」—— 逐个核对它们是不是各属不同模块`)
  }
  report.splitAdvice = {
    mustAsk,
    level: mustAsk ? 'must-ask' : report.parsable ? 'probably-single' : 'unknown',
    reasons,
  }
  // 典型反例提示：判断「不需要拆」也要有理由，别让模型默默放过
  report.splitAdvice.reasons.push(
    mustAsk
      ? '处置：**不许自己拆**。用 `ask_user_question` 把「建议拆分方案 + 依据（章节号/页数区间）」摆给用户确认，确认后再建模块。'
      : '未命中强制拆分判据；若用户口述里出现并列功能（"包含/以及/里面还有"），仍要停下来问，不许自己放过。',
  )
  return report
}

/** 把探针结果渲染成给人/给模型看的中文摘要。 */
export function renderProbe(report) {
  const lines = []
  const name = path.basename(report.file)
  lines.push(`## 需求文档探针：${name}`)
  lines.push('')
  if (!report.exists) {
    lines.push(`❌ 文件不存在或读不到：\`${report.file}\``)
    return lines.join('\n')
  }
  lines.push(`- 绝对路径：\`${report.file}\``)
  lines.push(`- 大小：${(report.bytes / 1024 / 1024).toFixed(2)} MB ｜ 类型：\`${report.kind}\``)
  if (!report.parsable) {
    lines.push('- **不可解析** —— 以下结论不成立')
    for (const w of report.warnings) lines.push(`  - ${w}`)
    return lines.join('\n')
  }
  lines.push(
    `- 页数：**${report.pages}**${report.pagesEstimated ? '（估算）' : '（Word `docProps/app.xml` 记录值）'}`
    + ` ｜ 段落：${report.paragraphCount} ｜ 表格：${report.tables} ｜ 图片：${report.images}`,
  )
  lines.push(`- 正文约 ${report.bodyChars} 字 ｜ 章节 ${report.headingCount} 条 ｜ 带删除线段落 ${report.strikethroughParagraphs} 段`)
  if (report.words !== null) lines.push(`- Word 统计：${report.words} 词 / ${report.characters} 字符 / ${report.paragraphs} 段`)
  if (report.menuHits.length) {
    lines.push('')
    lines.push('**命中的顶级菜单名**（最硬的拆分判据）：')
    for (const h of report.menuHits) lines.push(`- ${h.menu} —— 正文出现 ${h.count} 处`)
  }
  if (report.suspectedModules.length) {
    lines.push('')
    lines.push('**疑似子模块（一/二级标题里像功能名的）**：')
    lines.push(report.suspectedModules.map((t) => `\`${t}\``).join('、'))
  }
  lines.push('')
  lines.push(`**拆分判定：${report.splitAdvice.level === 'must-ask' ? '⚠️ 必须问用户（不许自己拆）' : report.splitAdvice.level === 'probably-single' ? '未命中强制判据' : '无法判定'}**`)
  for (const r of report.splitAdvice.reasons) lines.push(`- ${r}`)
  if (report.headings.length) {
    lines.push('')
    lines.push(`**章节树**（前 ${report.headings.length} 条，缩进 = 层级）：`)
    for (const h of report.headings) {
      lines.push(`${'  '.repeat(Math.max(0, h.level - 1))}- ${h.title}`)
    }
  }
  // 划掉项联动框架铁律 11
  if (report.strikethroughParagraphs > 0) {
    lines.push('')
    lines.push(`⚠️ 本文件有 **${report.strikethroughParagraphs} 段带删除线/修订删除** —— 按框架铁律 11：`
      + '**划掉的不当需求读**，但**必须单独出「取消项核对表」逐项到测试环境确认系统里是不是也去掉了**'
      + '（环境里还留着 = 残留，提缺陷）。详见 `requirement-docs` skill。')
  }
  for (const w of report.warnings) lines.push(`> ⚠️ ${w}`)
  return lines.join('\n')
}
