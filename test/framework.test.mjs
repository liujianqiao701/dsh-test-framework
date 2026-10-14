/**
 * 冒烟：把插件当用户那样用一遍，验证脚手架 / 登记 / 模块 / 探针 / 渲染在真实磁盘上都成立。
 *
 * 跑法：`node --test test/`（或 `npm test`）。
 * 刻意**不引任何测试框架**，只 `node:test` + `node:assert`。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  scaffold,
  frameworkStatus,
  renderGate,
  addModule,
  recordDocuments,
  recordEnvironments,
  readRegistry,
  recomputeGates,
  missingItems,
  upsertTableRow,
  findFrameworkRoot,
  isFrameworkRoot,
  listProducts,
  listModules,
  defaultReqDocRoot,
  setReqDocRoot,
} from '../lib/framework.js'
import { renderTemplate, KNOWN_KEYS, TEMPLATE_ROOT, readTemplate, listTemplateFiles } from '../lib/templates.js'
import { checkPrerequisites, renderPrereqBlock, detectProfileMcp } from '../lib/prereq.js'
import { checkIsolation, renderIsolationBlock, renderIsolationStatus, scanExternalAuthorities } from '../lib/isolation.js'
import { probeDocx, isOle, isZip, decodeXml, parseDocumentXml } from '../lib/docx.js'
import { SKILLS } from '../lib/skills.js'
import { TOOLS } from '../lib/tools.js'
import {
  BUBBLE_DIR,
  ARCHIVE_SCRIPT,
  ARCHIVE_ROOT_REL,
  DEFAULT_HOURS,
  findPython,
  productsWithScript,
  planReportGc,
  runReportGc,
  renderReportGc,
} from '../lib/report-gc.js'

const PRODUCT = '测试产品'
let COUNTER = 0

/** 建一个干净的一次性目录。
 *
 * 建的目录都登记进 `TEMP_DIRS`，收尾时统一删（见下面的 `after` 钩子）。
 * 以前只在个别用例里手删，跑一轮就漏一批 —— 实测本机 `%TEMP%` 里积了 900 多个
 * `testfw-*` 空壳。跟框架里"垃圾不入库"是同一条道理：**自己造的临时物自己收拾**。
 */
const TEMP_DIRS = []
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `testfw-${process.pid}-${COUNTER++}-`))
  TEMP_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 已经没了就算了 */ }
  }
})

/** 建一个已初始化的框架，返回根。 */
function freshFramework(options = {}) {
  const root = tmpdir()
  const plan = scaffold({ root, product: PRODUCT, git: 'skip', pluginVersion: '0.1.0', ...options })
  return { root, plan }
}

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

test('脚手架在空目录里建出完整骨架，且登记文件是合法 JSON', () => {
  const { root, plan } = freshFramework({ module: '缺药登记', menu: '药品联动保障', route: '/drugStorage', slug: 'queyao-dengji' })

  for (const rel of [
    'AGENTS.md',
    'README.md',
    '_templates/模块骨架/SKILL.md',
    // 模块规范是**按版本分开**的：索引之外还要有版本骨架，否则新框架建不出 <模块>\skill\<版本>\
    path.join('_templates', '模块骨架', 'skill', '版本骨架', 'SKILL.md'),
    '_templates/测试报告模板.md',
    'skills/db-seeding/SKILL.md',
    'skills/requirement-docs/SKILL.md',
    'skills/vision-read/SKILL.md',
    `${PRODUCT}/_框架配置/环境与账密.md`,
    `${PRODUCT}/_框架配置/需求文档台账.md`,
    `${PRODUCT}/_框架配置/模块路由.md`,
    `${PRODUCT}/_框架配置/框架登记.json`,
    // 报告回收脚本随框架一起落地（插件自己不重写归档逻辑，只去找并调用它）
    path.join(PRODUCT, '_冒泡测试', 'archive_reports.py'),
    `${PRODUCT}/缺药登记/SKILL.md`,
    '.dsh-test-framework.json',
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `缺文件：${rel}`)
  }

  // 归档区（报告回收的落点）也要在骨架里就建好
  assert.ok(fs.existsSync(path.join(root, '_archive', '报告归档')), '缺 _archive/报告归档')

  // 落地的那份归档脚本必须和插件模板**逐字节一致** —— 两处实现漂移的话，
  // 「归档规则到底是什么」就没人说得清了
  const tplScript = path.join(TEMPLATE_ROOT, '产品', '_冒泡测试', 'archive_reports.py')
  const installed = path.join(root, PRODUCT, '_冒泡测试', 'archive_reports.py')
  assert.equal(
    fs.readFileSync(installed, 'utf8'),
    fs.readFileSync(tplScript, 'utf8'),
    '落地的 archive_reports.py 与插件模板不一致',
  )

  // 登记文件必须是**真能解析**的 JSON（这正是修掉的那个非法转义 bug）
  const registry = JSON.parse(fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '框架登记.json'), 'utf8'))
  assert.equal(registry.schema, 'dsh-test-framework/product/v1')
  assert.equal(registry.product, PRODUCT)
  assert.equal(registry.frameworkRoot, root, 'Windows 反斜杠路径必须被正确转义')
  assert.deepEqual(registry.modules.map((m) => m.name), ['缺药登记'])

  // 模板里的占位符必须**全部**被替换（不许有残留的 {{X}}）
  for (const rel of ['AGENTS.md', 'README.md', `${PRODUCT}/_框架配置/模块路由.md`]) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    const leftovers = [...text.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1])
    assert.deepEqual(leftovers, [], `${rel} 还有没被替换的占位符：${leftovers.join(', ')}`)
  }

  assert.ok(plan.created.length > 0)
  // 登记文件是**本次新建**的，不能被报成「跳过（已存在）」——它由代码生成，不是模板渲染的
  const regRel = path.join(PRODUCT, '_框架配置', '框架登记.json')
  assert.ok(plan.created.includes(regRel), `框架登记.json 应算新建：${plan.created.join(', ')}`)
  assert.ok(!plan.skipped.includes(regRel))
  assert.ok(!plan.warnings.some((w) => w.includes('模板缺失')), `模板缺失告警：${plan.warnings.join(' | ')}`)
  assert.ok(root && fs.existsSync(root))
})

test('脚手架不覆盖已存在的文件，也不重复登记', () => {
  const { root } = freshFramework()
  const agents = path.join(root, 'AGENTS.md')
  const before = fs.readFileSync(agents, 'utf8')

  const second = scaffold({ root, product: PRODUCT, git: 'skip', pluginVersion: '0.1.0' })
  assert.equal(fs.readFileSync(agents, 'utf8'), before, 'AGENTS.md 不许被重写')
  assert.ok(second.skipped.includes('AGENTS.md'))
  assert.ok(second.created.length < 3, `第二次不该大建：${second.created.join(', ')}`)
})

test('dryRun 不落盘', () => {
  const root = tmpdir()
  const plan = scaffold({ root, product: PRODUCT, git: 'skip', dryRun: true })
  assert.ok(plan.created.length === 0 && plan.skipped.length === 0)
  assert.ok(plan.plan.length > 0, 'dryRun 要给出计划')
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')))
})

test('识别框架根：有 AGENTS.md + _templates 或标记文件', () => {
  const { root } = freshFramework()
  assert.ok(isFrameworkRoot(root))
  assert.equal(findFrameworkRoot(root)?.root, root)
  // 从子目录也能往上找到
  const sub = path.join(root, PRODUCT, '缺药登记')
  fs.mkdirSync(sub, { recursive: true })
  assert.equal(findFrameworkRoot(sub)?.root, root)
  // 不相干的目录找不到
  assert.equal(findFrameworkRoot(tmpdir()), undefined)
})

// ---------------------------------------------------------------------------
// 模块登记
// ---------------------------------------------------------------------------

test('addModule 建目录、渲染 SKILL.md、两处路由表都回填，且幂等', () => {
  const { root } = freshFramework()
  const r = addModule({
    root,
    product: PRODUCT,
    module: '短缺评估',
    menu: '药品联动保障',
    menuPath: '药品联动保障 > 短缺评估',
    route: '/shortageAssess',
    slug: 'duanque-pinggu',
    doc: '某地个性化需求.docx',
    version: '2606',
  })
  for (const sub of ['requirement', 'final', 'report', 'data', 'skill']) {
    assert.ok(fs.existsSync(path.join(root, PRODUCT, '短缺评估', sub)), `缺目录 ${sub}`)
  }
  const skill = fs.readFileSync(path.join(root, PRODUCT, '短缺评估', 'SKILL.md'), 'utf8')
  assert.ok(skill.includes('duanque-pinggu'), 'slug 要渲染进 frontmatter')
  assert.ok(skill.includes('药品联动保障'), '菜单要渲染进正文')
  assert.ok(!/\{\{\s*[A-Z0-9_]+\s*\}\}/.test(skill), '模块 SKILL.md 不许有未替换的占位符')

  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('短缺评估'), '要回填 AGENTS.md §三')
  const routes = fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '模块路由.md'), 'utf8')
  assert.ok(routes.includes('短缺评估'), '要回填产品级 模块路由.md')

  // 幂等：再调一次，不许在表里堆第二行、不许覆盖 SKILL.md
  const skillBefore = skill
  addModule({ root, product: PRODUCT, module: '短缺评估', menu: '药品联动保障', slug: 'duanque-pinggu' })
  assert.equal(fs.readFileSync(path.join(root, PRODUCT, '短缺评估', 'SKILL.md'), 'utf8'), skillBefore, 'SKILL.md 不许被覆盖')
  const agentsAfter = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert.equal(agentsAfter.split('| 短缺评估 |').length - 1, 1, 'AGENTS.md 里只该有一行「短缺评估」')
  assert.ok(r.warnings.length === 0 || r.warnings.some((w) => w.includes('已存在')), r.warnings.join(' | '))
})

test('listModules / listProducts 认得出模块，且把 _ 开头当辅助目录', () => {
  const { root } = freshFramework()
  addModule({ root, product: PRODUCT, module: '缺药登记', slug: 'queyao-dengji' })
  addModule({ root, product: PRODUCT, module: '余缺调拨', slug: 'yuque-diaobo' })
  assert.deepEqual(listModules(path.join(root, PRODUCT)), ['余缺调拨', '缺药登记'])
  assert.ok(listProducts(root).includes(PRODUCT))
  assert.ok(!listProducts(root).includes('skills'), 'skills 不是产品')
  assert.ok(!listProducts(root).includes('_templates'), '下划线开头不是产品')
})

// ---------------------------------------------------------------------------
// 登记与闸门
// ---------------------------------------------------------------------------

test('闸门：拆分 / 跨文档 / 版本 / 环境 逐项拦住，补齐后放行', () => {
  const { root } = freshFramework()
  let status = frameworkStatus({ root, product: PRODUCT })
  let p = status.products[0]
  assert.equal(p.ready, false)

  // 空产品：什么都没登记
  let missing = p.missing.map((m) => m.key)
  assert.ok(missing.includes('documentsRegistered'))
  assert.ok(missing.includes('environmentRegistered'))

  // 登记文档但**不写 relatedDocs**（= 跨文档还没问过）
  recordDocuments(root, PRODUCT, [{ name: '某地个性化需求.docx', version: '2606', pages: 137, split: ['缺药登记'] , splitConfirmed: true }], {})
  p = frameworkStatus({ root, product: PRODUCT }).products[0]
  missing = p.missing.map((m) => m.key)
  assert.ok(!missing.includes('documentsRegistered'), '文档已登记')
  assert.ok(missing.includes('crossDocChecked'), '**缺 key** 必须被当成「没问过」')
  assert.ok(missing.includes('environmentRegistered'))

  // 补上 relatedDocs: []（= 问过了、答"没有"）—— 必须被当成有效答案
  recordDocuments(root, PRODUCT, [{ name: '某地个性化需求.docx', relatedDocs: [] }], {})
  p = frameworkStatus({ root, product: PRODUCT }).products[0]
  missing = p.missing.map((m) => m.key)
  assert.ok(!missing.includes('crossDocChecked'), 'relatedDocs: [] 是有效答案，闸门要放行')

  // 登记环境 + 模块
  recordEnvironments(root, PRODUCT, [{ name: '主环境', url: 'http://127.0.0.1:8000/login', account: 'u', password: 'p', dbHost: '127.0.0.1', dbPort: '5432', dbName: 'db', schema: 's', dbUser: 'u2', dbPassword: 'p2' }], {})
  addModule({ root, product: PRODUCT, module: '缺药登记', slug: 'queyao-dengji' })
  p = frameworkStatus({ root, product: PRODUCT }).products[0]
  assert.equal(p.ready, true, `还缺：${p.missing.map((m) => m.key).join(', ')}`)
  assert.ok(p.gates.splitConfirmed && p.gates.crossDocChecked && p.gates.versionsConfirmed && p.gates.environmentRegistered)
})

test('版本没确认时闸门拦住', () => {
  const { root } = freshFramework()
  recordDocuments(root, PRODUCT, [{ name: 'a.docx', split: ['x'], splitConfirmed: true, relatedDocs: [] }], {})
  const p = frameworkStatus({ root, product: PRODUCT }).products[0]
  assert.equal(p.gates.versionsConfirmed, false)
  assert.ok(p.missing.some((m) => m.key === 'versionsConfirmed'))
})

test('密码只落 Markdown，不进 框架登记.json', () => {
  const { root } = freshFramework()
  const SECRET = 'SuperSecret-123456'
  recordEnvironments(root, PRODUCT, [{
    name: '主环境', url: 'http://x/login', account: 'admin', password: SECRET,
    dbHost: '10.0.0.1', dbPort: '5432', dbName: 'db', schema: 's', dbUser: 'user', dbPassword: `${SECRET}-db`,
  }], {})

  const md = fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '环境与账密.md'), 'utf8')
  assert.ok(md.includes(SECRET), '密码要落进人读的产品级规范')
  assert.ok(md.includes('admin'))

  const json = fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '框架登记.json'), 'utf8')
  assert.ok(!json.includes(SECRET), '**框架登记.json 里不许出现密码明文**')
  const reg = JSON.parse(json)
  assert.equal(reg.environments[0].passwordStored, '_框架配置\\环境与账密.md')
  assert.ok(reg.environments[0].account === 'admin')
})

test('登记是幂等的：同一文档/环境反复登记不堆行', () => {
  const { root } = freshFramework()
  for (let i = 0; i < 3; i += 1) {
    recordDocuments(root, PRODUCT, [{ name: 'dup.docx', version: `v${i}`, split: ['m'], splitConfirmed: true, relatedDocs: [] }], {})
    recordEnvironments(root, PRODUCT, [{ name: '主环境', url: `http://x${i}` }], {})
  }
  const reg = JSON.parse(fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '框架登记.json'), 'utf8'))
  assert.equal(reg.documents.length, 1)
  assert.equal(reg.documents[0].version, 'v2', '后写的要覆盖前面的')
  assert.equal(reg.environments.length, 1)
  assert.equal(reg.environments[0].url, 'http://x2')
})

test('upsertTableRow：替换占位行、追加新行、定位不到时如实返回', () => {
  const md = ['| 模块 | 定位 | 资料 |', '| --- | --- | --- |', '| （待登记） | | |', ''].join('\n')
  const one = upsertTableRow(md, ['模块', '定位'], 0, ['缺药登记', 'a', 'b'])
  assert.equal(one.action, 'replace-placeholder')
  assert.ok(one.md.includes('| 缺药登记 | a | b |'))
  assert.ok(!one.md.includes('（待登记）'))

  const two = upsertTableRow(one.md, ['模块', '定位'], 0, ['短缺评估', 'c', 'd'])
  assert.equal(two.action, 'append')
  assert.ok(two.md.includes('缺药登记') && two.md.includes('短缺评估'))

  const three = upsertTableRow(two.md, ['模块', '定位'], 0, ['缺药登记', 'CHANGED', 'b'])
  assert.equal(three.action, 'replace')
  assert.ok(three.md.includes('CHANGED'))
  assert.equal(three.md.split('缺药登记').length - 1, 1, '替换不许留下旧行')

  const none = upsertTableRow('没有表格', ['模块'], 0, ['x'])
  assert.equal(none.ok, false)
  assert.equal(none.action, 'no-table')
})

// ---------------------------------------------------------------------------
// 渲染 / 模板
// ---------------------------------------------------------------------------

test('模板渲染：整词替换、未知 key 保留并告警', () => {
  const r = renderTemplate('{{PRODUCT}} / {{ PRODUCT }} / {{NOPE}}', { PRODUCT: 'P' })
  assert.equal(r.text, 'P / P / {{NOPE}}')
  assert.ok(r.warnings.some((w) => w.includes('NOPE')))

  const empty = renderTemplate('{{MODULE}}', { MODULE: '' })
  assert.equal(empty.text, '{{MODULE}}', '空值要保留原样，不许渲染成空字符串')
  assert.ok(empty.warnings.length > 0)
})

test('全部模板只使用允许的占位符', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
  const files = walk(TEMPLATE_ROOT).filter((f) => /\.(md|json|yml|txt)$/i.test(f))
  assert.ok(files.length >= 9, `模板文件数偏少：${files.length}`)
  const bad = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (!KNOWN_KEYS.has(m[1])) bad.push(`${path.relative(TEMPLATE_ROOT, f)} → ${m[1]}`)
    }
  }
  assert.deepEqual(bad, [], `模板里有插件不认识的占位符：${bad.join('; ')}`)
})

test('渲染后的产品级 JSON 模板仍是合法 JSON', () => {
  const { root } = freshFramework()
  const files = ['框架登记.json']
  for (const f of files) {
    const p = path.join(root, PRODUCT, '_框架配置', f)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')), `${f} 不是合法 JSON`)
  }
})

// ---------------------------------------------------------------------------
// docx 探针
// ---------------------------------------------------------------------------

test('docx 探针认出非 Office 文件与不存在的文件，不抛', () => {
  const root = tmpdir()
  const txt = path.join(root, 'note.txt')
  fs.writeFileSync(txt, 'hello', 'utf8')
  const r = probeDocx(txt)
  assert.equal(r.exists, true)
  assert.equal(r.parsable, false)
  assert.equal(r.kind, 'not-office')
  assert.ok(r.splitAdvice.level === 'blocked')

  const missing = probeDocx(path.join(root, 'nope.docx'))
  assert.equal(missing.exists, false)
  assert.ok(missing.warnings.length > 0)

  // OLE（加密 docx / 老 .doc）要认得出来，并给出正确处置
  const ole = path.join(root, 'enc.docx')
  fs.writeFileSync(ole, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]))
  const r2 = probeDocx(ole)
  assert.equal(r2.kind, 'ole-encrypted')
  assert.ok(r2.warnings.join(' ').includes('requirement-docs'), '要指向解密脚本')
})

test('zip / XML 基础件行为正确', () => {
  assert.ok(isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
  assert.ok(!isZip(Buffer.from([0x50, 0x4b])))
  assert.ok(isOle(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
  assert.equal(decodeXml('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f')
  assert.equal(decodeXml('&#65;&#x42;'), 'AB')

  // 段落解析：标题层级、删除线、图片、分页
  const xml = [
    '<w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>缺药登记</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>短缺评估</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>正常段落</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:rPr><w:strike/></w:rPr></w:pPr><w:r><w:t>划掉的需求</w:t></w:r></w:p>',
    '<w:p><w:r><w:drawing/></w:r></w:p>',
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:tbl><w:tr><w:tc/></w:tr></w:tbl>',
    '</w:body>',
  ].join('')
  const p = parseDocumentXml(xml)
  const levels = p.paragraphs.filter((x) => x.level > 0).map((x) => `${x.level}:${x.text}`)
  assert.deepEqual(levels, ['1:缺药登记', '2:短缺评估'])
  assert.equal(p.strikes, 1)
  assert.equal(p.images, 1)
  assert.equal(p.pageBreaks, 1)
  assert.equal(p.tables, 1)
})

// ---------------------------------------------------------------------------
// 插件元数据自洽
// ---------------------------------------------------------------------------

test('每个 skill 都是合法的 SkillRegistration 形状', () => {
  assert.ok(SKILLS.length >= 4)
  const names = new Set()
  for (const s of SKILLS) {
    assert.match(s.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `skill 名必须是 kebab-case：${s.name}`)
    assert.ok(!names.has(s.name), `skill 名重复：${s.name}`)
    names.add(s.name)
    assert.ok(typeof s.description === 'string' && s.description.trim().length > 30, `${s.name} 的 description 太短`)
    assert.ok(typeof s.content === 'string' && s.content.length > 500, `${s.name} 的正文太短`)
    assert.ok(s.content.startsWith('#'), `${s.name} 的正文应以 # 标题开头`)
  }
  assert.ok(names.has('test-framework-onboard'), '必须有引导流程 skill')
})

test('每个工具都是合法的 ToolDefinition 形状（不依赖 defineTool）', () => {
  assert.ok(TOOLS.length >= 6)
  const names = new Set()
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `工具名不合法：${t.name}`)
    assert.equal(t.name === 'run_code', false, 'run_code 是保留名')
    assert.ok(!names.has(t.name), `工具名重复：${t.name}`)
    names.add(t.name)
    assert.ok(typeof t.description === 'string' && t.description.length > 60, `${t.name} 的 description 太短`)
    assert.equal(typeof t.execute, 'function')
    // register() 强制：output 必须是对象，render 必须是函数，schema 必须存在
    assert.equal(typeof t.output, 'object')
    assert.equal(typeof t.output.render, 'function')
    assert.equal(typeof t.output.schema, 'object')
    assert.deepEqual(t.output.render([], { text: 'x' }), [{ type: 'text', text: 'x' }])
    // parameters 必须是合法 JSON Schema 对象
    assert.equal(typeof t.parameters, 'object')
    assert.ok(t.parameters.type === 'object' || t.parameters.type === undefined)
    assert.ok(Array.isArray(t.parameters.required))
  }
})

test('skill 正文里提到的工具名都真的注册了', () => {
  const registered = new Set(TOOLS.map((t) => t.name))
  const mentioned = new Set()
  for (const s of SKILLS) {
    // 裸词匹配：skill 里的工具调用大部分写在代码块里，不一定带反引号
    for (const m of s.content.matchAll(/\btest_framework_[a-z_]+\b/g)) mentioned.add(m[0])
  }
  const unknown = [...mentioned].filter((n) => !registered.has(n))
  assert.deepEqual(unknown, [], `skill 里提到但没注册的工具：${unknown.join(', ')}`)
  // 每个工具都至少该在某个 skill 里出现过 —— 否则模型不知道该用它
  const never = [...registered].filter((n) => !mentioned.has(n))
  assert.deepEqual(never, [], `这些工具在任何 skill 里都没出现，模型不会知道要用：${never.join(', ')}`)
})

test('renderGate：没框架/缺项/完好 三种情况都有合理输出', () => {
  const empty = renderGate({ frameworkRoot: null, products: [], warnings: [] })
  assert.ok(empty.includes('test_framework_init'), '没框架时要提示初始化')

  const { root } = freshFramework()
  const gate = renderGate(frameworkStatus({ root, product: PRODUCT }))
  assert.ok(gate.includes('不许直接开测') || gate.includes('缺'), '缺项时要说清不许开测')
  assert.ok(gate.includes('ask_user_question'), '要明确指出用 ask_user_question 一次问清')

  // 注入提示词的正文里绝不能出现 {{ —— renderPrompt 是严格模式，会抛错
  assert.ok(!gate.includes('{{'), '注入的正文里不许出现 {{')
  assert.ok(!renderGate({ frameworkRoot: null }).includes('{{'))
})

// ---------------------------------------------------------------------------
// 前置条件（必需的外部 MCP）—— 用户口径："强制要求使用 playwright MCP"
//
// 这些测试**只用临时夹具**（自己造一个假的 `$DSH_HOME`），
// 绝不读跑测机器上真实的 `~\.dsh` —— 否则"在没配 MCP 的机器上跑测试就红"，
// 而那是环境差异，不是代码错。
// ---------------------------------------------------------------------------

/** 造一个假的 `$DSH_HOME`：一个 desktop profile，可选地配好 playwright。 */
function fakeDshHome({ playwright = true, patchFile = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-prereq-'))
  TEMP_DIRS.push(home)
  const dir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  if (patchFile) {
    const body = playwright
      ? ['plugins:', '  - id: mcp-playwright', '    config:', '      serverName: playwright', "      args:", "        - '@playwright/mcp'"]
      : ['plugins:', '  - id: mcp-other', '    config:', '      serverName: other_mcp']
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `${body.join('\n')}\n`)
  }
  return home
}

test('前置条件：能从 cordis.patch.yml 认出 serverName（不引 YAML 库）', () => {
  const home = fakeDshHome({ playwright: true })
  const d = detectProfileMcp({ dshHome: home, profile: 'desktop' })
  assert.equal(d.exists, true)
  assert.ok(d.serverNames.includes('playwright'), `要认出 serverName：${d.serverNames.join('、')}`)
  assert.ok(d.ids.includes('mcp-playwright'), `要认出 - id：${d.ids.join('、')}`)

  const r = checkPrerequisites({ dshHome: home, profile: 'desktop' })
  assert.equal(r.items.find((i) => i.key === 'playwright').found, true)
  assert.deepEqual(r.items.find((i) => i.key === 'playwright').where, ['desktop'])
})

test('前置条件：playwright 没配 → 必须报「必需 + 没有替代路径」，且给配置位置', () => {
  const r = checkPrerequisites({ dshHome: fakeDshHome({ playwright: false }), profile: 'desktop' })
  const pw = r.items.find((i) => i.key === 'playwright')
  assert.equal(pw.required, true, 'playwright 必须是必需项')
  assert.equal(pw.found, false)

  const block = renderPrereqBlock(r)
  assert.ok(block.includes('playwright'), '必须点名 playwright')
  assert.ok(block.includes('必需'), '必须写明是必需项')
  assert.ok(block.includes('未检测到'), '措辞必须是"未检测到"（不能说"不存在"）')
  assert.ok(block.includes('没有替代路径'), '必须写清没有替代路径（用户口径）')
  assert.ok(block.includes('cordis.patch.yml'), '必须告诉人配在哪')
  assert.ok(block.includes('重启 DSH'), '必须提醒改完要重启')
  assert.ok(!block.includes('{{'), '注入正文不许有 {{')
})

test('前置条件：配好了就不出声 —— 可选 MCP 缺失也不许变成每个会话的噪音', () => {
  const r = checkPrerequisites({ dshHome: fakeDshHome({ playwright: true }), profile: 'desktop' })
  assert.equal(r.items.find((i) => i.key === 'playwright').found, true)
  // keyword / cr69 没配（夹具里就没有）—— 但必需项满足了 ⇒ 整段为空
  assert.equal(renderPrereqBlock(r), '', '必需项满足时不许出任何提示')
})

test('前置条件：读不到 cordis.patch.yml 时说「无法判定」，不下否定结论', () => {
  const r = checkPrerequisites({ dshHome: fakeDshHome({ patchFile: false }), profile: 'desktop' })
  assert.equal(r.items.find((i) => i.key === 'playwright').found, undefined, '查不到 ≠ 不存在，不能返回 false')
  assert.ok(renderPrereqBlock(r).includes('无法判定'))
})

test('前置条件：登记全对也不能把「缺必需 MCP」掩盖掉（renderGate 不许整段跳过）', () => {
  const prereqs = checkPrerequisites({ dshHome: fakeDshHome({ playwright: false }), profile: 'desktop' })
  const gate = renderGate({
    frameworkRoot: 'X:\\faketree', agentsMdAutoLoaded: true, products: [], warnings: [], prereqs,
  })
  assert.ok(gate.includes('playwright'), '登记没问题 + 缺必需 MCP ⇒ 仍然要报，这是本版的核心修复')
  assert.ok(!gate.includes('{{'))

  // 反过来：配好了就回到"无事可报 = 空字符串"（不占 token）
  const fine = checkPrerequisites({ dshHome: fakeDshHome({ playwright: true }), profile: 'desktop' })
  assert.equal(renderGate({
    frameworkRoot: 'X:\\faketree', agentsMdAutoLoaded: true, products: [], warnings: [], prereqs: fine,
  }), '')
})

test('前置条件：profile 层不共享 —— 别的 profile 配了、当前 profile 没配 = 等于没配', () => {
  const home = fakeDshHome({ playwright: true })
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{}')
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'plugins: []\n')

  const r = checkPrerequisites({ dshHome: home, profile: 'web' })
  const pw = r.items.find((i) => i.key === 'playwright')
  assert.equal(pw.found, true, '整体上"检测到了"（desktop 里有）')
  assert.equal(pw.inActiveProfile, false, '但当前 profile 里没有 —— 这一项必须能分辨出来')
  assert.deepEqual(pw.where, ['desktop'])
})

// ---------------------------------------------------------------------------
// 防干扰（隔离）—— 用户口径："加上不被干扰机制，不要被其他项目的框架影响"
//
// 起因是**真事故**：本机**另一套工具链的工作区**（自带另一份完整 AGENTS.md）
// 的"落盘必须在工作区内"这条规矩渗进了本框架，模块里被建出一批**永远装不进东西**的
// `temps\_P1_temps\` 空壳（工具会拒收工作区外路径），模块 SKILL.md 里还留下"照着做必然失败"的经验。
//
// ⚠️ 这些测试**只用临时夹具**，绝不读跑测机器上真实的框架或别的项目目录 ——
// 否则"这台机器上正好有别家的 AGENTS.md"就会让测试红，那是环境差异，不是代码错。
// ---------------------------------------------------------------------------

test('防干扰：干净的框架一个字都不报（不占 token）', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' }) // 默认会建 .git 根标记
  const iso = checkIsolation({ root, cwd: root })
  assert.equal(iso.contract.loaded, true, '项目根 = 框架根 ⇒ 契约会被自动加载')
  assert.deepEqual(iso.stray.dirs, [], '刚建出来的骨架不该有外来目录')
  assert.deepEqual(iso.items, [], '没发现就不该有 findings')
  assert.equal(renderIsolationBlock(iso), '', '没发现 ⇒ 空字符串（不占 token）')
})

test('防干扰：嵌套仓库截断契约要报，且不能**误诊**成"框架根没 .git"', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' }) // 框架根**有** .git
  const inner = path.join(root, '_plugin', 'inner')
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true }) // 框架树内部的嵌套仓库

  const iso = checkIsolation({ root, cwd: inner })
  assert.equal(iso.markers.git, true, '框架根的 .git 好好的')
  assert.equal(iso.contract.truncatedBy, path.resolve(inner), '要认出是嵌套仓库截断的')
  assert.equal(iso.contract.loaded, false)
  const block = renderIsolationBlock(iso)
  assert.ok(block.includes('嵌套仓库'), '必须点明是嵌套仓库')
  assert.ok(!block.includes('框架根没有'), '框架根明明有 .git —— 不许误诊')
})

test('防干扰：项目根跑到框架**外面**时，要点名生效的是谁的契约', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' })
  const outside = tmpdir()
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), '# 别家的契约\n')

  // 显式给 `projectRoot`：模拟「DSH 把项目根解析到了框架外」这个**事实**本身。
  // 不靠 `findGitRoot` 自己走上去找 —— 那会依赖跑测机器上有没有 `C:\.git` 之类的环境差异。
  const iso = checkIsolation({ root, projectRoot: outside, cwd: outside })
  assert.equal(iso.contract.foreignRoot, path.resolve(outside))
  assert.equal(iso.contract.loaded, false)
  const block = renderIsolationBlock(iso)
  assert.ok(block.includes('外面'), '要说清项目根在框架外')
  assert.ok(block.includes(path.join(outside, 'AGENTS.md')), '要点名实际会加载的是哪份 AGENTS.md')
  assert.ok(block.includes(root), '也要给出本框架框架根，方便对照')
})

test('防干扰：模块里的外来目录（temps）算污染，要报并给出正确做法', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0', module: '缺药登记', menu: '药品联动保障', slug: 'queyao-dengji' })
  const moduleDir = path.join(root, PRODUCT, '缺药登记')
  fs.mkdirSync(path.join(moduleDir, 'temps', '_P1_temps'), { recursive: true })
  fs.writeFileSync(path.join(moduleDir, 'notes.md'), 'x') // 散落文件：只是没归位

  const iso = checkIsolation({ root, cwd: root })
  assert.ok(iso.stray.dirs.some((h) => h.rel.endsWith(path.join('temps'))), 'temps 要被认出来')
  assert.ok(iso.stray.files.some((h) => h.rel.endsWith('notes.md')))
  const block = renderIsolationBlock(iso)
  assert.ok(block.includes('temps'), '要点名是哪个目录')
  assert.ok(block.includes('data'), '要说清正确做法：落它自己的工作区、证据拷回 data\\')
  // 散落**文件**是有意的生成落点也可能是没归位 —— 闸门不拿它刷噪音
  assert.ok(!block.includes('notes.md'), '散落文件不进闸门（本框架自己就有一个有意的产物）')
})

test('防干扰：`skills\\` 是辅助目录、不是产品 —— 别把 vision-read\\engine 误报成外来目录', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' })
  fs.mkdirSync(path.join(root, 'skills', 'vision-read', 'engine'), { recursive: true })

  const iso = checkIsolation({ root, cwd: root })
  // 实测踩到过：只按"下划线开头 = 辅助目录"判断，会把 `skills` 当产品、
  // `vision-read` 当模块，于是正当的 `engine\` 被报成"别的工具的工作目录"。
  assert.deepEqual(iso.stray.dirs, [], '框架辅助目录下的嵌套内容不该被算成污染')
  assert.equal(renderIsolationBlock(iso), '')
})

test('防干扰：标记不全要报（.git 是契约加载的唯一凭据）', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0', git: 'skip' })
  const iso = checkIsolation({ root, cwd: root })
  assert.ok(iso.items.some((i) => i.key === 'no-git'))
  assert.ok(renderIsolationBlock(iso).includes('.git'))
  assert.ok(iso.items.some((i) => i.key === 'no-git' && i.fix.includes('test_framework_init')))
})

test('防干扰：外部权威**只报告、不进闸门**（天天刷"检测到 N 个外部权威"是噪音）', () => {
  const parent = tmpdir()
  const root = path.join(parent, 'fw')
  fs.mkdirSync(root)
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' })
  const other = path.join(parent, 'other')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'AGENTS.md'), '# 另一份完整契约\n')
  fs.mkdirSync(path.join(other, '.trae'), { recursive: true })

  const externals = scanExternalAuthorities(root)
  assert.ok(externals.some((e) => e.path === path.join(other, 'AGENTS.md')), '兄弟目录的契约要被扫到')
  assert.ok(externals.some((e) => e.path === path.join(other, '.trae')), '.trae 规范库也要被扫到')

  const iso = checkIsolation({ root, cwd: root })
  assert.equal(renderIsolationBlock(iso), '', '从框架根本身开会话 ⇒ 外部权威不影响本会话 ⇒ 闸门闭嘴')
  const statusText = renderIsolationStatus(iso)
  assert.ok(statusText.includes('外部'), '但 status 里要如实列出来')
  assert.ok(statusText.includes(other), '并且列出具体路径')
})

test('防干扰：有发现时闸门**不许**因为"登记没问题"就整段跳过', () => {
  const root = tmpdir()
  scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0' })
  const status = frameworkStatus({ root, product: PRODUCT, skipPrereq: true })
  // 造一个"登记全对 + 契约没加载"的状态：这正是最容易被漏掉的那种
  const fake = {
    ...status,
    agentsMdAutoLoaded: true,
    products: [{ ...status.products[0], ready: true, missing: [] }],
    isolation: { ...status.isolation, items: [{ key: 'stray-dirs', level: 'warn', title: '测试用发现', detail: '', fix: '' }] },
  }
  const gate = renderGate(fake)
  assert.ok(gate.includes('防干扰'), '有干扰就必须出现在闸门里')
  assert.ok(!gate.includes('{{'), '注入的正文里不许出现 {{')

  // 反过来：没干扰、登记全对、前置条件没问题 ⇒ 空字符串
  const clean = {
    ...status,
    agentsMdAutoLoaded: true,
    products: [{ ...status.products[0], ready: true, missing: [] }],
    prereqs: null,
    isolation: { ...status.isolation, items: [] },
  }
  assert.equal(renderGate(clean), '', '全干净就该是空字符串')
})

test('登记函数两种调用方式都行（位置参数 / 对象参数）', () => {
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testfw-shape-'))
    TEMP_DIRS.push(root)
    scaffold({ root, product: PRODUCT, pluginVersion: '0.1.0', git: 'skip' })
    return root
  }
  const doc = {
    name: 'X.docx', system: 'S', version: '2606', pages: 10,
    split: ['M1'], splitConfirmed: true, relatedDocs: [],
  }
  const env = { name: 'E', url: 'http://x', account: 'a', password: 'p', dbHost: 'h', dbName: 'd' }

  // ① 位置参数
  const r1 = mk()
  try {
    recordDocuments(r1, PRODUCT, [doc])
    recordEnvironments(r1, PRODUCT, [env])
    const reg = readRegistry(r1, PRODUCT).registry
    assert.equal(reg.documents.length, 1)
    assert.equal(reg.environments.length, 1)
  } finally {
    fs.rmSync(r1, { recursive: true, force: true })
  }

  // ② 对象参数（frameworkStatus / addModule 用的就是这种形状，两种并存极容易写错）
  const r2 = mk()
  try {
    recordDocuments({ root: r2, product: PRODUCT, documents: [doc] })
    recordEnvironments({ root: r2, product: PRODUCT, environments: [env] })
    const reg = readRegistry(r2, PRODUCT).registry
    assert.equal(reg.documents.length, 1)
    assert.equal(reg.environments.length, 1)
  } finally {
    fs.rmSync(r2, { recursive: true, force: true })
  }
})

test('默认常量与空登记的形状符合框架约定', () => {
  const empty = recomputeGates({})
  for (const key of ['documentsRegistered', 'versionsConfirmed', 'crossDocChecked', 'splitConfirmed', 'environmentRegistered']) {
    assert.equal(empty[key], false, `空登记时 ${key} 必须是 false`)
  }
  // 空登记也要能算出「该问什么」，不能因为字段缺失就崩
  const missing = missingItems({})
  assert.ok(missing.length >= 2)
  assert.ok(missing.every((m) => typeof m.key === 'string' && typeof m.ask === 'string' && m.ask.length > 5))
})

test('需求文档总根目录：不写死绝对路径，配置 > 环境变量 > 用户主目录兜底', () => {
  const savedEnv = process.env.DSH_REQ_DOC_ROOT
  try {
    // ① 什么都没给 —— 兜底必须是「用户主目录下」，**且不能是别人的盘符**
    delete process.env.DSH_REQ_DOC_ROOT
    setReqDocRoot('')
    const bare = defaultReqDocRoot()
    assert.equal(bare, path.join(os.homedir(), '需求业务文档'), '兜底该是 <用户主目录>\\需求业务文档')
    // 硬红线：**源码里不许出现写死的个人绝对路径**。
    // 只断言"兜底不等于某个字面量"是不够的（本机 homedir 恰好也在用户目录下）——
    // 所以直接扫源码与模板，从根上挡住"作者盘符被发到别人机器上"。
    //
    // ⚠️ 这里踩过一次：最初的正则只认**单反斜杠**（`D:\Users\...`），
    // 而源码里是**双反斜杠转义**（`'D:\\Users\\...'`）—— 结果守卫一路"通过"，
    // 写死的路径却随 0.2.0~0.2.3 四版发了出去。现在统一**先把连续反斜杠压成一个**再匹配。
    const normalize = (s) => s.replace(/\\\\+/g, '\\')
    // 只抓**具体的**用户名路径（`X:\Users\<真名字>\`）：
    // 占位符（`<名字>` / `you`）与"正则写法"（`[A-Za-z]:\Users\`）都不是泄漏，
    // 否则这条守卫会被自己文档里的说明文字反复绊倒。
    const HARDCODED = /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/
    const offenders = []
    const scan = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        // 跳过本文件：下面的 HARDCODED 正则**字面量本身**就长得像它要抓的东西，
        // 扫自己必然自指命中。本文件里的真实泄漏由"本机词表"那条测试兜底（它不跳过本文件）。
        if (e.name === 'framework.test.mjs') continue
        const p = path.join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) scan(p, r)
        else if (/\.(js|mjs|md|json|yml)$/.test(e.name) && HARDCODED.test(normalize(fs.readFileSync(p, 'utf8'))))
          offenders.push(r)
      }
    }
    // 扫**整个包**（README / package.json / test 都算）——
    // 0.2.1 那次就是只扫了 lib 与 templates，结果漏在别处。
    scan(path.join(TEMPLATE_ROOT, '..'))
    assert.deepEqual(offenders, [], `这些文件里还写死着个人绝对路径：\n${offenders.join('\n')}`)

    // ② 环境变量
    process.env.DSH_REQ_DOC_ROOT = 'E:\\公司\\需求文档'
    assert.equal(defaultReqDocRoot(), 'E:\\公司\\需求文档')

    // ③ 插件配置优先级最高（profile 的 cordis.patch.yml 里 config.reqDocRoot）
    setReqDocRoot('F:\\配置优先')
    assert.equal(defaultReqDocRoot(), 'F:\\配置优先')

    // ④ 配置给空串 = 不生效，回落到环境变量（别把空当有效值）
    setReqDocRoot('   ')
    assert.equal(defaultReqDocRoot(), 'E:\\公司\\需求文档')

    // ⑤ 显式参数依旧能覆盖一切：脚手架生成的 AGENTS.md 里要出现传进去的那个路径
    const { root } = freshFramework({ reqDocRoot: 'G:\\显式传的' })
    try {
      const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
      assert.ok(agents.includes('G:\\显式传的'), '显式 reqDocRoot 要渲染进 AGENTS.md')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  } finally {
    setReqDocRoot('')
    if (savedEnv === undefined) delete process.env.DSH_REQ_DOC_ROOT
    else process.env.DSH_REQ_DOC_ROOT = savedEnv
  }
})

// ---------------------------------------------------------------------------
// 模块规范按版本分开（要求：「一个模块下面区分多个版本，不要所有 skill 融合在一个版本」）
// ---------------------------------------------------------------------------

const MOD = { module: '缺药登记', menu: '药品联动保障', menuPath: '药品联动保障 > 缺药登记', route: '/drugStorage', slug: 'queyao-dengji' }

test('addModule 带 version：索引 + skill\\<版本>\\SKILL.md 两份都落，索引 §8 自动补行', () => {
  const { root } = freshFramework()
  const r = addModule({ root, product: PRODUCT, ...MOD, doc: '某地个性化需求.docx', version: '2606' })

  const indexRel = path.join(PRODUCT, '缺药登记', 'SKILL.md')
  const verRel = path.join(PRODUCT, '缺药登记', 'skill', '2606', 'SKILL.md')
  assert.ok(fs.existsSync(path.join(root, indexRel)), '缺模块索引 SKILL.md')
  assert.ok(fs.existsSync(path.join(root, verRel)), '缺 skill/2606/SKILL.md')
  assert.equal(r.versionSkillPath, path.join(root, verRel), 'versionSkillPath 要是绝对路径')
  assert.equal(r.skillPath, path.join(root, indexRel))
  assert.ok(r.created.includes(verRel), `created 里该有版本规范：${r.created.join(', ')}`)

  const ver = fs.readFileSync(path.join(root, verRel), 'utf8')
  assert.ok(ver.includes('2606'), '版本号要渲染进版本规范')
  assert.ok(ver.includes('queyao-dengji-2606'), 'frontmatter 的 name 要带模块 slug + 版本')
  assert.ok(!/\{\{\s*[A-Z0-9_]+\s*\}\}/.test(ver), '版本规范不许有未替换的占位符')
  // 版本规范里必须真有「本版需求范围」与「造数逻辑」两段 —— 这正是按版本分开的理由
  assert.ok(ver.includes('§V2'), '版本规范要有 §V2 本版需求范围')
  assert.ok(ver.includes('§V4'), '版本规范要有 §V4 造数逻辑')
  assert.ok(ver.includes('§V6'), '版本规范要有 §V6 本版报告')

  // 索引 §8 要**真能列出这一版**（只建文件不登记 = 下一版没入口）
  const index = fs.readFileSync(path.join(root, indexRel), 'utf8')
  assert.ok(index.includes('2606'), '索引 §8 版本索引要出现 2606')
  assert.ok(index.includes('skill\\2606\\SKILL.md') || index.includes('skill/2606/SKILL.md'), '§8 要指向该版规范')
  assert.ok(!index.includes('| （待补） | `skill'), '占位行该被真实版本行顶掉')
  assert.ok(index.includes('| 当前在测版本 | 2606'), '§1 当前在测版本要填上')
  assert.ok(!/\{\{\s*[A-Z0-9_]+\s*\}\}/.test(index), '索引不许有未替换的占位符')

  // AGENTS.md §三 与 模块路由.md 都要带上"这一版"
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('2606'), 'AGENTS.md §三 要写明版本')
  const routes = fs.readFileSync(path.join(root, PRODUCT, '_框架配置', '模块路由.md'), 'utf8')
  assert.ok(routes.includes('2606'), '模块路由.md 要有版本列')
  assert.ok(routes.includes('skill/2606/SKILL.md'), '模块路由.md 要链接到版本规范')
})

test('两个版本并存：第二版新开一份，绝不覆盖第一版', () => {
  const { root } = freshFramework()
  const v1Rel = path.join(PRODUCT, '缺药登记', 'skill', '2606', 'SKILL.md')
  addModule({ root, product: PRODUCT, ...MOD, version: '2606' })
  const v1 = fs.readFileSync(path.join(root, v1Rel), 'utf8')

  const r2 = addModule({ root, product: PRODUCT, ...MOD, version: '2607' })
  const v2Rel = path.join(PRODUCT, '缺药登记', 'skill', '2607', 'SKILL.md')
  assert.ok(fs.existsSync(path.join(root, v2Rel)), '缺 skill/2607/SKILL.md')
  assert.equal(fs.readFileSync(path.join(root, v1Rel), 'utf8'), v1, '2606 版规范不许被 2607 覆盖')
  assert.ok(fs.readFileSync(path.join(root, v2Rel), 'utf8').includes('2607'))
  assert.ok(r2.warnings.some((w) => w.includes('已存在')), `索引是累积型文档，第二版该报"已存在"：${r2.warnings.join(' | ')}`)

  // 索引里**两版同时在**，各指各的文件
  const index = fs.readFileSync(path.join(root, PRODUCT, '缺药登记', 'SKILL.md'), 'utf8')
  assert.ok(index.includes('2606') && index.includes('2607'), '索引要同时列出两版')
  assert.equal(index.split('| 2606 |').length - 1, 1, '2606 那行只该有一行')
  assert.equal(index.split('| 2607 |').length - 1, 1, '2607 那行只该有一行')

  // 幂等：同一版再登记一次，**不许在 §8 里堆出重复行**
  // （注意：§1「当前在测版本」会被改成最后一次登记的那版 —— 这是有意的，它是"当前"）
  addModule({ root, product: PRODUCT, ...MOD, version: '2606' })
  const after = fs.readFileSync(path.join(root, PRODUCT, '缺药登记', 'SKILL.md'), 'utf8')
  const verRows = after.split(/\r?\n/).filter((l) => /^\|\s*(2606|2607)\s*\|/.test(l))
  assert.equal(verRows.length, 2, `§8 版本索引只该有两行：\n${verRows.join('\n')}`)
  assert.equal(after.split('| 2606 |').length - 1, 1)
  assert.equal(after.split('| 2607 |').length - 1, 1)
  assert.ok(after.includes('| 当前在测版本 | 2606'), '§1 当前在测版本要跟着最后一次登记走')
})

test('不给 version 就不建版本规范，并且必须给出显式警告（不许静默）', () => {
  const { root } = freshFramework()
  const r = addModule({ root, product: PRODUCT, ...MOD })
  assert.equal(r.versionSkillPath, undefined)
  assert.ok(!fs.existsSync(path.join(root, PRODUCT, '缺药登记', 'skill', '2606', 'SKILL.md')))
  assert.ok(
    r.warnings.some((w) => w.includes('没给 version')),
    `没给 version 必须警告：${r.warnings.join(' | ')}`,
  )
  // 索引仍是索引（占位行留着，等人补版本）
  const index = fs.readFileSync(path.join(root, PRODUCT, '缺药登记', 'SKILL.md'), 'utf8')
  assert.ok(index.includes('§8 版本索引'))
})

test('模板里就带着「按版本分开」的三件套，不会渲染出旧结构', () => {
  // ① 版本骨架必须存在且含 §V1~§V6
  const verTpl = readTemplate(path.join('模块骨架', 'skill', '版本骨架', 'SKILL.md'))
  for (const sec of ['§V1', '§V2', '§V3', '§V4', '§V5', '§V6']) {
    assert.ok(verTpl.includes(sec), `版本骨架缺 ${sec}`)
  }
  // ② 模块骨架是**索引**：要指向 skill\<版本>\，并明说"不要把多版塞进一份"
  const indexTpl = readTemplate(path.join('模块骨架', 'SKILL.md'))
  assert.ok(indexTpl.includes('skill\\<版本>\\SKILL.md'), '模块骨架要指向版本规范')
  assert.ok(indexTpl.includes('不要'), '模块骨架要写明"不要把多个版本塞进一份"')
  // ③ 脚手架要能整棵树搬过去（版本骨架在子目录里，漏列就会静默少文件）
  const files = listTemplateFiles('模块骨架')
  assert.ok(files.includes('SKILL.md'))
  assert.ok(files.includes('skill/版本骨架/SKILL.md'), `模块骨架漏了版本骨架：${files.join(', ')}`)
})

test('AGENTS.md / README.md 模板：版本化 skill、报告写法、归档根都已改到位', () => {
  for (const rel of ['AGENTS.md', 'README.md']) {
    const tpl = readTemplate(rel)
    // 归档根改名（旧口径 _archive\冒泡测试\ 已废）
    assert.ok(!tpl.includes('_archive\\冒泡测试'), `${rel} 还留着旧归档根 _archive\\冒泡测试\\`)
    assert.ok(tpl.includes('报告归档'), `${rel} 要指向 _archive\\报告归档\\`)
    // 版本化 skill 两层
    assert.ok(tpl.includes('skill\\<版本>\\SKILL.md'), `${rel} 要写明 skill\\<版本>\\SKILL.md`)
    // 测试报告硬要求（用户要求"一目了然"）
    assert.ok(tpl.includes('缺陷速览'), `${rel} 要写"缺陷速览表在最前"`)
    assert.ok(tpl.includes('需求原文依据'), `${rel} 要写"需求原文依据"`)
    assert.ok(tpl.includes('与需求不符点'), `${rel} 要写"与需求不符点"`)
    assert.ok(tpl.includes('复现步骤'), `${rel} 要写"复现步骤"`)
    // 只允许出现已知占位符，否则渲染会留残留（脚手架测试也会挂，这里离原因更近）
    for (const m of tpl.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) {
      assert.ok(KNOWN_KEYS.has(m[1]), `${rel} 里有未知占位符 {{${m[1]}}}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 报告回收（满 24h 自动归档）
// ---------------------------------------------------------------------------

test('productsWithScript 只认真正落地了归档脚本的产品', () => {
  const { root } = freshFramework()
  const names = (r) => productsWithScript(r, { listProducts }).map((x) => x.product)
  assert.deepEqual(names(root), [PRODUCT], '脚本是脚手架落的，该被认出来')

  // 没脚本的产品不算（否则会去调一个不存在的文件）
  fs.mkdirSync(path.join(root, '另一个产品', BUBBLE_DIR), { recursive: true })
  assert.deepEqual(names(root), [PRODUCT])

  fs.rmSync(path.join(root, PRODUCT, BUBBLE_DIR, ARCHIVE_SCRIPT))
  assert.deepEqual(names(root), [], '脚本没了就不该再报这个产品')
})

test('planReportGc：默认 dryRun、指到落地脚本、目录根本地化', () => {
  const { root } = freshFramework()
  // 显式给 python：否则"本机没装 python"会把 ok 变成 false，测的就不是规划逻辑了
  const plan = planReportGc({ root, product: PRODUCT, deps: { listProducts }, python: 'python' })
  assert.equal(plan.ok, true, plan.failure ?? '')
  assert.equal(plan.product, PRODUCT)
  assert.equal(plan.script, path.join(root, PRODUCT, BUBBLE_DIR, ARCHIVE_SCRIPT))
  assert.equal(plan.archiveRoot, path.join(root, ARCHIVE_ROOT_REL))
  assert.equal(plan.hours, DEFAULT_HOURS, '默认就该是 24 小时')
  assert.equal(plan.dryRun, true, '插件入口默认只看不动')
  assert.ok(plan.argv.includes('--dry-run'), `dryRun 要把 --dry-run 传给脚本：${plan.argv.join(' ')}`)
  assert.ok(plan.argv.includes('--hours') && plan.argv.includes('24'))

  // 真归档：argv 里不许再有 --dry-run
  const real = planReportGc({ root, product: PRODUCT, deps: { listProducts }, python: 'python', dryRun: false })
  assert.equal(real.dryRun, false)
  assert.ok(!real.argv.includes('--dry-run'), '真归档不许带 --dry-run')

  // --all / --hours 透传
  const all = planReportGc({ root, product: PRODUCT, deps: { listProducts }, python: 'python', hours: 48, all: true, dryRun: false })
  assert.ok(all.argv.includes('--all'))
  assert.ok(all.argv.includes('48'))

  // 产品没落地脚本 → 明确失败，而不是假装成功
  fs.rmSync(path.join(root, PRODUCT, BUBBLE_DIR, ARCHIVE_SCRIPT))
  const broken = planReportGc({ root, product: PRODUCT, deps: { listProducts }, python: 'python' })
  assert.equal(broken.ok, false)
  assert.ok(broken.failure.includes(ARCHIVE_SCRIPT), `失败原因要点名脚本：${broken.failure}`)

  // 没注入 listProducts → 报"插件内部错误"，别静默挑一个
  const noDeps = planReportGc({ root, python: 'python' })
  assert.equal(noDeps.ok, false)
  assert.ok(noDeps.failure.includes('listProducts'))
})

test('renderReportGc：人类可读，且明说"只调用同一份 python 脚本"', () => {
  const { root } = freshFramework()
  const plan = planReportGc({ root, product: PRODUCT, deps: { listProducts }, python: 'python' })
  const text = renderReportGc({ ok: true, status: 0, output: '将归档 2 项', plan })
  assert.ok(text.startsWith('# 报告回收'), text.slice(0, 40))
  assert.ok(text.includes(PRODUCT))
  assert.ok(text.includes('24'))
  assert.ok(text.includes('将归档 2 项'), '脚本输出要原样带出来')

  const fail = renderReportGc({ ok: false, status: 1, output: '', plan, failure: '没找到 python' })
  assert.ok(fail.includes('❌') || fail.includes('失败'), '失败要有显眼标记')
  assert.ok(fail.includes('没找到 python'))
})

test('runReportGc：真跑一次 dry-run（本机没 python 就明确跳过，不许假装通过）', (t) => {
  const python = findPython()
  if (!python) {
    t.skip('本机没有可用的 python，跳过真跑')
    return
  }
  const { root } = freshFramework()
  const plan = planReportGc({ root, product: PRODUCT, deps: { listProducts } })
  assert.equal(plan.ok, true, plan.failure ?? '')
  const r = runReportGc({ plan })
  assert.equal(r.ok, true, `dry-run 该成功：status=${r.status} ${r.output}`)
  assert.equal(r.status, 0)
  // dry-run 绝不能真搬东西
  assert.equal(fs.readdirSync(path.join(root, '_archive', '报告归档')).length, 0, 'dry-run 不许产生归档产物')
})

test('report_gc 工具：默认只看不动里外一致（错一次就会真搬文件）', async () => {
  const tool = TOOLS.find((x) => x.name === 'test_framework_report_gc')
  assert.ok(tool, '缺 test_framework_report_gc 工具')
  const props = tool.parameters.properties ?? {}
  assert.ok(props.hours && props.all && props.product && props.dryRun, '要能指定 hours / all / product / dryRun')
  assert.equal(tool.isConcurrencySafe(), false, '会动文件，不算并发安全')
  assert.ok(tool.description.includes('dryRun'), '描述里要写清默认只预演')

  // 描述里说"默认只预演"，行为就必须真的只预演 —— 两处不一致会让人误搬文件
  assert.equal(tool.presentCall({}).kind, 'read', '不传 dryRun 时该当只读')
  assert.equal(tool.presentCall({ dryRun: false }).kind, 'write')
  assert.ok(tool.presentCall({}).title.includes('预演'))
  assert.ok(tool.presentCall({ dryRun: false }).title.includes('真归档'))

  const { root } = freshFramework()
  const r = await tool.execute({ root, python: 'python' }, {})
  assert.ok(typeof r.text === 'string' && r.text.startsWith('# 报告回收'), r.text?.slice(0, 60))
  const data = JSON.parse(r.dataJson)
  assert.equal(data.plan.dryRun, true, '没传 dryRun 时必须规划成预演')
  assert.ok(data.plan.argv.includes('--dry-run'))
})

test('外传前复扫：整个包不许出现本机词表里的词（词表不进仓库，缺了就跳过）', (t) => {
  const pkgRoot = path.join(TEMPLATE_ROOT, '..')
  const blocklistPath = path.join(pkgRoot, '.privacy-blocklist.txt')
  if (!fs.existsSync(blocklistPath)) {
    // 公开仓库里没有这个词表 —— 跳过，而不是失败。
    // 词表本身不能进仓库，否则"守卫"等于又泄一次。
    t.skip('.privacy-blocklist.txt 不存在（公开仓库里正常）')
    return
  }
  const words = fs
    .readFileSync(blocklistPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  assert.ok(words.length > 0, '词表不能是空的')

  // 扫**整个包**，不只是 lib/ 与 templates/ ——
  // 0.2.1 那次就是只扫了源码，结果 README 的变更记录里把产品名原文写了出来。
  const SKIP_DIRS = new Set(['.git', 'node_modules'])
  const SKIP_FILES = new Set(['.privacy-blocklist.txt']) // 词表是"词"的出处，扫它必然自指
  const TEXT = /\.(js|mjs|cjs|md|json|yml|yaml|py|txt|sh|cmd)$/
  const offenders = []
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue
      const p = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else if (TEXT.test(e.name)) {
        // 反斜杠压缩：源码里是 `D:\\Users\\...`（转义双写），词表里写的是 `D:\Users\...`，
        // 不归一化就永远匹配不上 —— 0.2.0~0.2.3 就是这么漏出去的。
        const text = fs.readFileSync(p, 'utf8').replace(/\\\\+/g, '\\')
        for (const w of words) {
          if (text.includes(w.replace(/\\\\+/g, '\\'))) offenders.push(`${r}  ← 命中「${w}」`)
        }
      }
    }
  }
  walk(pkgRoot)
  assert.deepEqual(
    offenders,
    [],
    '这些文件里还残留着本机词表里的词 —— 发出去就会外传：\n' + offenders.join('\n'),
  )
})
