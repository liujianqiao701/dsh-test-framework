/**
 * 混淆构建：src\（可读源码，不发出去）→ dist\（打包 + 混淆，装给别人时只带这个）。
 *
 * 为什么这么做：
 *   插件是本地 Node 模块，代码必须在对方机器上以可执行形式存在 —— 所以拿不到"绝对保密"，
 *   只能把可读性砍掉：注释没了、变量名没了、字符串进了 base64 数组、控制流被平坦化。
 *   改一行也几乎不可能只改一处（改完基本必坏），"随手改"这条路就被堵住了。
 *
 * 三条硬约束（踩过才知道）：
 *   1. **renameGlobals 必须 false** —— 顶层 `export const name` / `export function apply(ctx)`
 *      一旦被改名，DSH 加载时就拿不到入口，插件直接不生效。
 *   2. **先 esbuild 打包再混淆**，别反过来：先混淆会留下相对 import，打包时按名字解析必失败。
 *   3. **cli 的 shebang 要剥掉**：混淆器不吃 `#!` 行；Windows 上 bin 由 npm 的 .cmd 垫片
 *      用 node 调用，本来也不需要 shebang。
 */
import { build } from 'esbuild'
import JavaScriptObfuscator from 'javascript-obfuscator'
import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const ENTRIES = [
  'index', 'cli', 'framework', 'docx', 'templates',
  'skills', 'prereq', 'isolation', 'budget', 'install',
]

const OBFUSCATOR = {
  compact: true,
  target: 'node',
  sourceType: 'module',
  // 顶层导出名必须保留，否则 DSH 拿不到 apply / name
  renameGlobals: false,
  identifierNamesGenerator: 'mangled-shuffled',
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.25,
  deadCodeInjection: false,
  // selfDefending 会让代码对格式化极度敏感，容易把自己搞坏，不开
  selfDefending: false,
  disableConsoleOutput: false,
  log: false,
}

const toPosix = (p) => p.split(path.sep).join('/')

async function main() {
  await fs.rm(path.join(ROOT, 'dist'), { recursive: true, force: true })
  await fs.mkdir(path.join(ROOT, 'dist'), { recursive: true })

  const started = Date.now()
  for (const name of ENTRIES) {
    const entry = path.join(ROOT, 'src', `${name}.js`)
    const outfile = path.join(ROOT, 'dist', `${name}.js`)

    const result = await build({
      entryPoints: [{ in: entry, out: outfile }],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      minify: true,
      legalComments: 'none',
      write: false,
    })

    let code = result.outputFiles[0].text
    code = code.replace(/^#!.*\r?\n/, '')            // 剥 shebang
    const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR).getObfuscatedCode()
    await fs.writeFile(outfile, obfuscated, 'utf8')

    const before = Buffer.byteLength(code)
    const after = Buffer.byteLength(obfuscated)
    console.log(`  ${`dist/${name}.js`.padEnd(22)} 打包 ${String(before).padStart(7)} B → 混淆 ${String(after).padStart(8)} B`)
  }

  // 自检：注释必须没了、源码里那句注释原文必须找不到。
  // （不查中文字符串 —— skill 正文本来就是给模型读的提示词，藏它没有意义，
  //   真正要藏的是"这段逻辑在干什么"，也就是注释与标识符。）
  const distIndex = await fs.readFile(path.join(ROOT, 'dist', 'index.js'), 'utf8')
  const markers = ['/**', 'cordis 宿主侧入口', '框架根识别 / 状态与闸门']
  const left = markers.filter((s) => distIndex.includes(s))
  if (left.length > 0) {
    throw new Error(`dist/index.js 里还能看到源码痕迹：${left.join(', ')}`)
  }
  const cjk = (distIndex.match(/[\u4e00-\u9fa5]/g) || []).length
  console.log(`  ✔ 自检：注释已清除；仍可见中文字符 ${cjk} 个（多为提示词正文，属预期）`)
  console.log(`  ✔ ${ENTRIES.length} 个入口全部混淆完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().catch((error) => {
  console.error('构建失败：' + (error && error.stack ? error.stack : error))
  process.exit(1)
})