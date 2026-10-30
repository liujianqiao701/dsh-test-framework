/**
 * install.js 的测试。
 *
 * ⚠️ **绝不在真 profile 上跑**：所有用例都在 `fs.mkdtempSync` 出来的假 `DSH_HOME`
 * 里造 profile，跑完删掉。真装机只在用户点头后手动执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  listProfiles,
  readProfileManifest,
  readPluginMeta,
  installedState,
  planInstall,
  applyInstall,
  applyUninstall,
  defaultDshHome,
} from '../lib/install.js'

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..')
const PLUGIN_NAME = 'dsh-test-framework'
let COUNTER = 0

/** 造一个假 DSH_HOME，里面放 N 个 profile。 */
function fakeDshHome(profiles = ['desktop']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `testfw-install-${process.pid}-${COUNTER++}-`))
  for (const name of profiles) {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      type: 'module',
      dependencies: { 'existing-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'existing-plugin'] } },
    }, null, 2)}\n`, 'utf8')
  }
  return home
}

const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 算了 */ } }

// ---------------------------------------------------------------------------

test('默认 DSH_HOME 与插件自身元数据', () => {
  assert.ok(defaultDshHome().length > 0)
  const meta = readPluginMeta(PLUGIN_DIR)
  assert.equal(meta.name, PLUGIN_NAME)
  assert.equal(meta.hasBundlePatch, true, 'package.json 必须有 dsh.bundle.patch')
})

test('listProfiles 只认有 package.json 的目录', () => {
  const home = fakeDshHome(['desktop', 'web'])
  fs.mkdirSync(path.join(home, 'profiles', 'empty-dir'), { recursive: true })
  try {
    assert.deepEqual(listProfiles(home).map((p) => p.name), ['desktop', 'web'])
  } finally {
    cleanup(home)
  }
})

test('planInstall：找不到 profile / 没声明 bundle patch 都要报错', () => {
  const home = fakeDshHome(['desktop'])
  try {
    const bad = planInstall({ pluginDir: PLUGIN_DIR, profile: 'nosuch', dshHome: home })
    assert.ok(bad.errors.some((e) => e.includes('nosuch')))
    assert.ok(bad.availableProfiles.includes('desktop'))

    // 假插件目录：没有 dsh.bundle.patch
    const fakePlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'testfw-fakeplugin-'))
    fs.writeFileSync(path.join(fakePlugin, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf8')
    try {
      const noPatch = planInstall({ pluginDir: fakePlugin, profile: 'desktop', dshHome: home })
      assert.ok(noPatch.errors.some((e) => e.includes('dsh.bundle.patch')), noPatch.errors.join('；'))
    } finally {
      cleanup(fakePlugin)
    }
  } finally {
    cleanup(home)
  }
})

test('link 模式：备份 + 写依赖与 bundles + 建目录联接，且不动别人的依赖', () => {
  const home = fakeDshHome(['desktop'])
  try {
    const r = applyInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home, mode: 'link' })
    assert.equal(r.ok, true, r.error ?? r.output)
    assert.ok(r.backup && fs.existsSync(r.backup), '一定要先备份')

    const manifest = readProfileManifest(path.join(home, 'profiles', 'desktop'))
    assert.equal(manifest.dependencies[PLUGIN_NAME], `link:${PLUGIN_DIR.replace(/\\/g, '/')}`)
    assert.ok(manifest.dsh.profile.bundles.includes(PLUGIN_NAME))
    // 别人的东西一个都不能少
    assert.equal(manifest.dependencies['existing-plugin'], '1.0.0')
    assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'))
    assert.ok(manifest.dsh.profile.bundles.includes('existing-plugin'))

    const st = installedState(path.join(home, 'profiles', 'desktop'), PLUGIN_NAME)
    assert.equal(st.installed, true, '依赖与 bundles 两处都要有')

    // 目录联接真的指到插件目录
    const linkPath = path.join(home, 'profiles', 'desktop', 'node_modules', PLUGIN_NAME)
    assert.ok(fs.existsSync(linkPath), '联接必须存在')
    assert.equal(fs.realpathSync(linkPath).toLowerCase(), fs.realpathSync(PLUGIN_DIR).toLowerCase())
    // 通过联接能读到插件入口 —— **入口从 package.json 的 main 读，别写死目录**：
    // 2026-10-27 把可读源码挪到 src\、发布件改成 dist\（混淆产物）时，这条写死的
    // `lib/index.js` 就成了唯一的误红点（真入口明明是好的）。布局一改就误红 = 坏守卫。
    const entry = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).main
    assert.ok(entry, 'package.json 必须声明 main')
    assert.ok(fs.existsSync(path.join(linkPath, entry)), `入口 ${entry} 必须能通过联接读到`)
  } finally {
    cleanup(home)
  }
})

test('link 模式幂等：重复安装不堆重复项', () => {
  const home = fakeDshHome(['desktop'])
  try {
    applyInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home, mode: 'link' })
    applyInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home, mode: 'link' })
    const manifest = readProfileManifest(path.join(home, 'profiles', 'desktop'))
    assert.equal(manifest.dsh.profile.bundles.filter((b) => b === PLUGIN_NAME).length, 1)
  } finally {
    cleanup(home)
  }
})

test('planInstall 认出「半装」状态', () => {
  const home = fakeDshHome(['desktop'])
  try {
    const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.dependencies[PLUGIN_NAME] = 'link:x' // 只在依赖里，bundles 里没有
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const plan = planInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home })
    assert.equal(plan.state.installed, false)
    assert.equal(plan.state.inDependencies, true)
    assert.equal(plan.state.inBundles, false)
    assert.ok(plan.warnings.some((w) => w.includes('半装')), plan.warnings.join(' | '))
  } finally {
    cleanup(home)
  }
})

test('uninstall：摘掉依赖、bundles 与联接，但不动别人的东西、也不删备份', () => {
  const home = fakeDshHome(['desktop'])
  try {
    applyInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home, mode: 'link' })
    const linkPath = path.join(home, 'profiles', 'desktop', 'node_modules', PLUGIN_NAME)
    assert.ok(fs.existsSync(linkPath))

    const r = applyUninstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home })
    assert.equal(r.ok, true, r.error)

    const manifest = readProfileManifest(path.join(home, 'profiles', 'desktop'))
    assert.equal(Object.hasOwn(manifest.dependencies, PLUGIN_NAME), false)
    assert.ok(!manifest.dsh.profile.bundles.includes(PLUGIN_NAME))
    assert.equal(manifest.dependencies['existing-plugin'], '1.0.0', '别人的依赖不许被删')
    assert.ok(!fs.existsSync(linkPath), '死链接要摘掉')
    assert.ok(fs.existsSync(r.backup), '备份不许被删')
  } finally {
    cleanup(home)
  }
})

test('装机计划里必须写明「要重启」与「默认不跑 pnpm」', () => {
  const home = fakeDshHome(['desktop'])
  try {
    const plan = planInstall({ pluginDir: PLUGIN_DIR, profile: 'desktop', dshHome: home })
    const text = plan.steps.join('\n')
    assert.ok(text.includes('重启'), '必须提示重启')
    assert.ok(text.includes('不跑 pnpm') || text.includes('未跑 pnpm'), '必须说明默认不跑 pnpm')
    assert.ok(text.includes('pnpm install'), '必须如实说明官方命令会跑 pnpm')
    assert.ok(plan.officialCommand.includes('dsh plugin --profile desktop add'))
  } finally {
    cleanup(home)
  }
})
