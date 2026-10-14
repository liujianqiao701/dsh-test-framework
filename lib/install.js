/**
 * 安装 / 卸载：把插件挂进某个 dsh profile。
 *
 * **首选官方路径**：`dsh plugin --profile <名字> add link:<插件目录>`
 * —— 它自己转发 pnpm，并**自动回写 `dsh.profile.bundles`**（这是插件成为 profile layer 的唯一凭据）。
 * 只有官方命令不可用时，才退回到「手工改 profile 的 package.json + 自己跑 pnpm」这条备用路。
 *
 * ⚠️ 这个模块**会写 profile 目录**（在 DSH 工作区之外）。所以：
 *   · 默认 `apply: false`，**只打印计划**；要真写必须显式 `--apply`；
 *   · 改 `package.json` 前**一定先备份**成 `package.json.bak-testfw-<时间戳>`；
 *   · 卸载只**摘掉**依赖与 bundles 条目，**不删备份、不动别人的依赖**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stamp } from './framework.js'
import { checkPrerequisites } from './prereq.js'

/** 默认 `$DSH_HOME`。 */
export function defaultDshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * 跑一个命令并收输出。
 *
 * 踩过两个 Windows/沙箱的坑，都在这里兜住：
 *
 * ① **必须走 shell**：`dsh` / `pnpm` 装出来的是 `.cmd` 批处理，而 Node 18.20+/20.12+ 起
 *    **拒绝在没有 shell 的情况下 spawn `.cmd`/`.bat`**（报 `EINVAL`）—— 于是"明明装了却报找不到"。
 * ② **受限沙箱里拿不到管道**：`shell: true` + 默认的 `pipe` stdio 会 `EPERM`
 *    （沙箱禁止程序开命名管道）。这时**降级到 `stdio: 'inherit'`**，让输出直接进终端、
 *    只取退出码 —— 人照样看得见结果，只是我们程序里拿不到文本。
 *
 * `quietFallback: true` 时改用 `stdio: 'ignore'`（探测可执行文件在不在时用，避免刷屏）。
 */
export function runCapture(command, args, options = {}) {
  const { quietFallback = false, ...spawnOptions } = options
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const base = { windowsHide: true, ...spawnOptions, ...(useShell ? { shell: true } : {}) }

  const r = spawnSync(command, args, { encoding: 'utf8', ...base })
  if (!r.error) {
    return { status: r.status, combined: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), inherited: false }
  }

  const pipeless = r.error.code === 'EPERM' || r.error.code === 'EINVAL'
  if (!pipeless) return { status: null, combined: '', error: r.error, inherited: false }

  const r2 = spawnSync(command, args, { ...base, stdio: quietFallback ? 'ignore' : 'inherit' })
  if (r2.error) return { status: null, combined: '', error: r2.error, inherited: false }
  return {
    status: r2.status,
    combined: '',
    inherited: true,
    note: quietFallback
      ? '受限环境下只取到退出码'
      : '受限环境下输出直接进终端，程序内未捕获文本',
  }
}

/** 列出所有 profile（`<dshHome>\profiles\<名字>\package.json` 存在才算）。 */
export function listProfiles(dshHome = defaultDshHome()) {
  const root = path.join(dshHome, 'profiles')
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name)
      const manifest = path.join(dir, 'package.json')
      return { name: e.name, dir, manifest, exists: fs.existsSync(manifest) }
    })
    .filter((p) => p.exists)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 解析一个 profile 的 package.json（失败返回 undefined）。 */
export function readProfileManifest(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** 插件包自己的名字与版本。 */
export function readPluginMeta(pluginDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
    return { name: pkg.name, version: pkg.version, hasBundlePatch: Boolean(pkg?.dsh?.bundle?.patch) }
  } catch {
    return undefined
  }
}

/** 这个插件是否已经装在某个 profile 上（依赖 + bundles 两处都算）。 */
export function installedState(profileDir, pluginName) {
  const manifest = readProfileManifest(profileDir)
  if (!manifest) return { manifest: undefined, inDependencies: false, inBundles: false, installed: false }
  const inDependencies = Object.hasOwn(manifest.dependencies ?? {}, pluginName)
  const bundles = manifest?.dsh?.profile?.bundles
  const inBundles = Array.isArray(bundles) && bundles.includes(pluginName)
  return { manifest, inDependencies, inBundles, installed: inDependencies && inBundles }
}

/** `...\_npx\<hash>\node_modules\...` 这种真实路径里取出 npx 缓存的 `<hash>` 目录。 */
function npxCacheRootOf(realTarget) {
  const m = /^(.*[\\/]_npx[\\/][^\\/]+)[\\/]node_modules[\\/]/.exec(realTarget)
  return m ? m[1] : undefined
}

/**
 * 一个 profile 可能在哪几层 `node_modules` 里链 `@deepseek-ai\*`。
 *
 * 本机实测是**两层**：`<profile>\node_modules`（只有 cosmokit / schemastery）与
 * `<dshHome>\profiles\node_modules`（`dsh` 本体在这里）。只查自己那层会漏，
 * 然后就会挑到 npx 缓存里另一个版本的 dsh。
 */
function profileLinkDirs(profileDir) {
  if (!profileDir) return []
  const dirs = [path.join(profileDir, 'node_modules'), path.join(path.dirname(profileDir), 'node_modules')]
  return [...new Set(dirs)]
}

/** `0.1.5-rc.3` 这类版本号比大小（不引 semver 依赖，够用就行）。 */
function compareVersions(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  // 数值相同：正式版 > 预发布版
  const ra = String(a).includes('-')
  const rb = String(b).includes('-')
  if (ra !== rb) return ra ? -1 : 1
  return String(a).localeCompare(String(b))
}

/** 列出所有 npx 缓存里的 dsh 候选（带版本，按版本降序）。 */
function npxDshCandidates() {
  const out = []
  if (!process.env.LOCALAPPDATA) return out
  const npxRoot = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
  let entries
  try {
    entries = fs.readdirSync(npxRoot)
  } catch {
    return out
  }
  for (const entry of entries) {
    const bin = path.join(npxRoot, entry, 'node_modules', '.bin', 'dsh.cmd')
    if (!fs.existsSync(bin)) continue
    let version = '0.0.0'
    try {
      version = JSON.parse(fs.readFileSync(path.join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
    } catch {
      /* 读不到版本就当最低 */
    }
    out.push({ path: bin, cacheRoot: path.join(npxRoot, entry), version })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * 找 `dsh` 可执行文件。
 *
 * 顺序（**有事实依据的优先**）：PATH → 这个 profile **自己链的那个** dsh →
 * npm 全局 → npx 缓存（按版本降序）。
 *
 * 为什么第二步这么绕：本机 npx 缓存里有**两个** dsh（`0.1.1-rc.2` 与 `0.1.5-rc.3`），
 * 而 profile 的 `node_modules\@deepseek-ai` 是**混着链过去**的。随便挑一个可能在
 * 另一个版本上改 `dsh.profile` 结构 —— 所以优先用 profile 里 `@deepseek-ai\dsh`
 * 真实指向的那一个。
 */
export function findDsh({ profileDir, override } = {}) {
  const probe = (cmd) => {
    const r = runCapture(cmd, ['--version'], { timeout: 30000, quietFallback: true })
    if (r.status !== 0) return undefined
    const first = (r.combined || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return first ?? '（版本未能读取）'
  }
  const wrap = (command, via, version) => ({ command, via, version })

  if (override) {
    const v = probe(override)
    return v ? wrap(override, '指定', v) : undefined
  }

  for (const cmd of ['dsh', 'dsh.cmd']) {
    const v = probe(cmd)
    if (v) return wrap(cmd, 'PATH', v)
  }

  // ② 这个 profile 实际链的 dsh
  //    注意要找**两层**：profile 自己的 node_modules，以及它上一层的 profiles\node_modules
  //    （本机实测 `@deepseek-ai\dsh` 就挂在上一层，只找自己那层会漏，然后挑到另一个版本的缓存）
  for (const base of profileLinkDirs(profileDir)) {
    try {
      const real = fs.realpathSync(path.join(base, '@deepseek-ai', 'dsh'))
      const cacheRoot = npxCacheRootOf(real)
      if (!cacheRoot) continue
      const bin = path.join(cacheRoot, 'node_modules', '.bin', 'dsh.cmd')
      if (!fs.existsSync(bin)) continue
      const v = probe(bin)
      if (v) {
        let version = v
        try {
          version = JSON.parse(fs.readFileSync(path.join(cacheRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
        } catch {
          /* 读不到就用 --version 的输出 */
        }
        return { command: bin, via: `profile 链的那个（${version}）`, version, cacheRoot }
      }
    } catch {
      /* 这层没有就下一层 */
    }
  }

  if (process.env.APPDATA) {
    const globalDsh = path.join(process.env.APPDATA, 'npm', 'dsh.cmd')
    if (fs.existsSync(globalDsh)) {
      const v = probe(globalDsh)
      if (v) return wrap(globalDsh, 'npm 全局', v)
    }
  }

  for (const c of npxDshCandidates()) {
    const v = probe(c.path)
    if (v) return { ...wrap(c.path, `npx 缓存 ${c.version}`, v), cacheRoot: c.cacheRoot }
  }
  return undefined
}

/**
 * 组装安装计划（**不落盘**，纯计算）。CLI 与工具都用它。
 */
export function planInstall({ pluginDir, profile, dshHome = defaultDshHome(), dsh: dshOverride }) {
  const plan = { pluginDir: path.resolve(pluginDir), profile, dshHome, steps: [], warnings: [], errors: [], state: undefined }
  const meta = readPluginMeta(plan.pluginDir)
  if (!meta) {
    plan.errors.push(`读不到插件清单：${path.join(plan.pluginDir, 'package.json')}`)
    return plan
  }
  plan.plugin = meta
  if (!meta.hasBundlePatch) {
    plan.errors.push('插件 package.json 里没有 `dsh.bundle.patch` —— 装了也不会成为 profile layer，等于没装。')
  }
  const profiles = listProfiles(dshHome)
  plan.availableProfiles = profiles.map((p) => p.name)
  const target = profiles.find((p) => p.name === profile)
  if (!target) {
    plan.errors.push(`找不到 profile「${profile}」。现有：${plan.availableProfiles.join('、') || '（一个都没有）'}`)
    return plan
  }
  plan.profileDir = target.dir
  plan.state = installedState(target.dir, meta.name)

  const linkPath = plan.pluginDir.replace(/\\/g, '/')
  plan.officialCommand = `dsh plugin --profile ${profile} add "link:${linkPath}"`
  plan.steps.push(
    `默认（推荐，不跑 pnpm）：改 \`${profile}\\package.json\` 的 dependencies 与 dsh.profile.bundles`
    + `，并在 \`${profile}\\node_modules\\${meta.name}\` 建目录联接指向插件目录。`,
  )
  plan.steps.push(`官方安装命令（会**真跑一次 pnpm install**，本机 profile 的 node_modules 是混版本状态，有被"规范化"的风险）：\n    ${plan.officialCommand}`)
  plan.steps.push('重启 DSH —— profile 的 cordis.patch.yml 与 bundles 层**不支持热加载**，不重启不生效。')
  plan.steps.push('重启后跑 `dsh-test-framework doctor` 或看会话里有没有出现 test_framework_* 工具来验证。')

  if (plan.state.installed) {
    plan.warnings.push(`看起来已经装过了（依赖与 bundles 里都有 \`${meta.name}\`）—— 重复安装是幂等的，但没必要时不用再装。`)
  } else if (plan.state.inDependencies || plan.state.inBundles) {
    plan.warnings.push(
      `**半装状态**：dependencies=${plan.state.inDependencies} / bundles=${plan.state.inBundles}。`
      + '只有两处都有才会真正加载 —— 用官方命令重跑一次即可补齐。',
    )
  }
  const dsh = findDsh({ profileDir: target.dir, override: dshOverride })
  plan.dsh = dsh
  plan.dshCandidates = npxDshCandidates().map((c) => `${c.version} @ ${c.path}`)
  if (!dsh) {
    plan.warnings.push(
      '在 PATH / npm 全局 / npx 缓存里都找不到 `dsh` 可执行文件 —— 请手工执行上面那条命令'
      + '（`dsh` 应该来自安装 DSH 时用的 npm/npx 环境），或用 `--dsh <dsh.cmd 路径>` 指定。',
    )
  } else if (dsh.version === '（版本未能读取）') {
    plan.warnings.push(
      `找到的 dsh（${dsh.via}）版本读不出来 —— 当前环境拿不到子进程输出（受限沙箱），`
      + '只看得到退出码，这不影响安装。',
    )
  }
  return plan
}

/**
 * 真装。
 *
 * **默认走 `link` 模式（最安全）**：只做三件事 —— 备份 `package.json`、把依赖与
 * `dsh.profile.bundles` 各加一条、在 `node_modules` 里建一个**目录联接**。
 * `link:` 依赖的本质就是这个链接，所以这条路和 pnpm 的产出等价。
 *
 * **为什么不默认跑 `dsh plugin add`**：它会在 profile 目录里真跑一次 `pnpm install`。
 * 本机 desktop profile 的 `node_modules\@deepseek-ai` 现在是**两个 dsh 版本混链**的状态
 * （`profiles\node_modules` 下 0.1.1-rc.2 与 0.1.5-rc.3 混着），一次 pnpm install
 * 很可能把这棵树"规范化"掉，**连带影响正在运行的 DSH**。装一个小插件不值得冒这个险。
 * 要用官方命令就显式传 `mode: 'official'`（会跑 pnpm）。
 *
 * @param {{ mode?: 'link'|'official' }} [options]
 * @returns {{ ok: boolean, used: string, backup?: string, output?: string, error?: string, next: string[] }}
 */
export function applyInstall({
  pluginDir,
  profile,
  dshHome = defaultDshHome(),
  mode = 'link',
  runPnpm = false,
  timeoutMs = 300000,
  dsh: dshOverride,
}) {
  const plan = planInstall({ pluginDir, profile, dshHome, dsh: dshOverride })
  const next = plan.steps.slice(1)
  if (plan.errors.length) return { ok: false, used: 'none', error: plan.errors.join('；'), plan, next }

  if (mode === 'official') {
    if (!plan.dsh) {
      return {
        ok: false,
        used: 'none',
        error: '找不到 `dsh` 可执行文件，不能走官方安装。改用手工链接（去掉 --official），或先用 --dsh <路径> 指定。',
        plan,
        next,
      }
    }
    const r = runCapture(
      plan.dsh.command,
      ['plugin', '--profile', profile, 'add', `link:${plan.pluginDir.replace(/\\/g, '/')}`],
      { timeout: timeoutMs },
    )
    const after = installedState(plan.profileDir, plan.plugin.name)
    if (r.status === 0 && after.installed) {
      return { ok: true, used: `dsh plugin add（${plan.dsh.via}）`, output: r.combined, plan, next }
    }
    const fallback = linkInstall({ plan, runPnpm })
    return {
      ok: fallback.ok,
      used: `dsh plugin add 未成功（exit ${r.status}${r.error ? ` / ${r.error.message}` : ''}）→ 已退回链接安装：${fallback.used}`,
      output: `${r.combined}\n----\n${fallback.output ?? ''}`,
      backup: fallback.backup,
      error: fallback.error,
      plan,
      next,
    }
  }

  const r = linkInstall({ plan, runPnpm })
  return { ...r, plan, next }
}

/**
 * 链接安装：改两份清单（先备份）+ 建目录联接。**默认不跑 pnpm**。
 *
 * `runPnpm: true` 时才跑一次 `pnpm install`（一般情况下没必要 —— 手动建的联接就是
 * `link:` 依赖该有的样子）。
 */
function linkInstall({ plan, runPnpm = false }) {
  const manifestPath = path.join(plan.profileDir, 'package.json')
  const backup = `${manifestPath}.bak-testfw-${stamp()}`
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8')
    fs.writeFileSync(backup, raw, 'utf8')
    const manifest = JSON.parse(raw)
    manifest.dependencies = manifest.dependencies ?? {}
    manifest.dependencies[plan.plugin.name] = `link:${plan.pluginDir.replace(/\\/g, '/')}`
    manifest.dsh = manifest.dsh ?? {}
    manifest.dsh.profile = manifest.dsh.profile ?? {}
    const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
    if (!bundles.includes(plan.plugin.name)) bundles.push(plan.plugin.name)
    manifest.dsh.profile.bundles = bundles
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    let output = `已把 \`${plan.plugin.name}\` 写进 dependencies 与 dsh.profile.bundles（备份：${backup}）。`

    // 建目录联接 —— 这就是 `link:` 依赖的本质，不跑 pnpm 也能成立
    const linkPath = path.join(plan.profileDir, 'node_modules', plan.plugin.name)
    let linked = false
    try {
      if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      fs.symlinkSync(plan.pluginDir, linkPath, 'junction')
      output += `\n✅ 已建目录联接：${linkPath}\n        → ${plan.pluginDir}`
      linked = true
    } catch (error) {
      output += `\n❌ 建联接失败：${error.message}\n`
        + `   请手工执行：New-Item -ItemType Junction -Path "${linkPath}" -Target "${plan.pluginDir}"`
    }

    if (runPnpm) {
      const pnpm = findPnpm()
      if (pnpm) {
        const r = runCapture(pnpm.command, ['install'], { cwd: plan.profileDir, timeout: 600000 })
        output += `\n\npnpm install（${pnpm.version}）：exit ${r.status}\n${r.combined.slice(-2000)}`
      } else {
        output += '\n\n⚠️ 找不到 pnpm，跳过 pnpm install（链接已经建好了，不影响加载）。'
      }
    } else {
      output += '\n\n（未跑 pnpm install —— 联接已经建好，等价于 `link:` 依赖的产出。'
        + '要跑加 `--pnpm`。）'
    }

    const after = installedState(plan.profileDir, plan.plugin.name)
    return {
      ok: after.installed && linked,
      used: runPnpm ? '改 profile 清单 + 建目录联接 + pnpm install' : '改 profile 清单 + 建目录联接（未跑 pnpm）',
      backup,
      output,
      error: after.installed && linked ? undefined : '清单已写但链接/条目没落实，看上面的输出',
    }
  } catch (error) {
    return { ok: false, used: '链接安装', backup, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 找 pnpm。 */
export function findPnpm() {
  const probe = (cmd) => {
    const r = runCapture(cmd, ['--version'], { timeout: 30000, quietFallback: true })
    if (r.status !== 0) return undefined
    const first = (r.combined || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return { command: cmd, version: first ?? '（版本未能读取）' }
  }
  for (const cmd of ['pnpm', 'pnpm.cmd']) {
    const hit = probe(cmd)
    if (hit) return hit
  }
  const candidates = []
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'))
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'pnpm.exe'))
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    const hit = probe(c)
    if (hit) return hit
  }
  return undefined
}

/** 卸载：只摘依赖与 bundles 条目（外加手动建的那个联接），**不删备份、不动别的依赖**。 */
export function applyUninstall({ pluginDir, profile, dshHome = defaultDshHome() }) {
  const plan = planInstall({ pluginDir, profile, dshHome })
  if (plan.errors.length) return { ok: false, error: plan.errors.join('；'), plan }
  const manifestPath = path.join(plan.profileDir, 'package.json')
  const backup = `${manifestPath}.bak-testfw-${stamp()}`
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8')
    fs.writeFileSync(backup, raw, 'utf8')
    const manifest = JSON.parse(raw)
    if (manifest.dependencies) delete manifest.dependencies[plan.plugin.name]
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      manifest.dsh.profile.bundles = bundles.filter((b) => b !== plan.plugin.name)
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // 顺手摘掉手动建的联接，否则会留下一个指向已卸载插件的死链接
    const linkPath = path.join(plan.profileDir, 'node_modules', plan.plugin.name)
    let linkNote = ''
    try {
      if (fs.existsSync(linkPath)) {
        fs.rmSync(linkPath, { recursive: true, force: true })
        linkNote = `\n已摘掉目录联接：${linkPath}`
      }
    } catch (error) {
      linkNote = `\n⚠️ 目录联接没能摘掉（${error.message}）：${linkPath}`
    }

    return {
      ok: true,
      backup,
      output: `已摘掉依赖与 bundles 条目；备份在 ${backup}。${linkNote}`
        + '\n⚠️ 框架工作区里的文件（AGENTS.md / skills / _框架配置 …）**没有动** —— 卸载插件不等于删框架。'
        + '\n重启 DSH 后生效。',
      next: ['重启 DSH。'],
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), backup }
  }
}

/** 体检：装得上吗、环境对不对。 */
export function doctor({ pluginDir, profile, dshHome = defaultDshHome(), dsh: dshOverride }) {
  const checks = []
  const add = (ok, label, detail) => checks.push({ ok, label, detail })

  const meta = readPluginMeta(pluginDir)
  add(Boolean(meta), '插件清单可解析', meta ? `${meta.name}@${meta.version}` : `读不到 ${path.join(pluginDir, 'package.json')}`)
  add(Boolean(meta?.hasBundlePatch), '声明了 dsh.bundle.patch', '这是插件成为 profile layer 的唯一凭据')
  const patchFile = path.join(pluginDir, 'cordis.patch.yml')
  add(fs.existsSync(patchFile), 'cordis.patch.yml 存在', patchFile)
  const entry = path.join(pluginDir, 'lib', 'index.js')
  add(fs.existsSync(entry), '宿主入口 lib/index.js 存在', entry)

  const nodeMajor = Number(process.versions.node.split('.')[0])
  add(nodeMajor >= 20, 'Node 版本 ≥ 20', `当前 ${process.version}`)

  const profiles = listProfiles(dshHome)
  add(profiles.length > 0, `找到 profile（${dshHome}）`, profiles.map((p) => p.name).join('、') || '一个都没有')
  const target = profile ? profiles.find((p) => p.name === profile) : undefined
  if (profile) {
    add(Boolean(target), `profile「${profile}」存在`, target ? target.dir : `现有：${profiles.map((p) => p.name).join('、')}`)
  }

  // dsh 可执行文件：优先用这个 profile 自己链的那个（本机 npx 缓存里有多个版本，随便挑会挑错）
  const dsh = findDsh({ profileDir: target?.dir, override: dshOverride })
  add(Boolean(dsh), '找得到 dsh 可执行文件', dsh
    ? `${dsh.command}\n       （来源：${dsh.via}，版本：${dsh.version}）`
    : 'PATH / npm 全局 / npx 缓存里都没有')

  if (target && meta) {
    const st = installedState(target.dir, meta.name)
    add(st.installed, '插件已装上（依赖 + bundles 两处都有）', st.installed
      ? '已安装'
      : `dependencies=${st.inDependencies} bundles=${st.inBundles} → 跑 install 补齐`)
  }
  const pnpm = findPnpm()
  add(Boolean(pnpm), '找得到 pnpm（备用安装路要用）', pnpm ? `${pnpm.command} ${pnpm.version}` : '没有 pnpm 就只能走官方 dsh plugin add')

  // 前置条件（外部 MCP）—— **playwright 是必需的**：铁律 10 要求「看着页面操作流程」必须用
  // 真实浏览器真实操作，且**不给替代路径**。所以这里缺了就判不通过（而不是"提示一下"）。
  // ⚠️ "未检测到"≠"不存在"：读不到 `cordis.patch.yml` 时是**无法判定**，不能算失败。
  const prereq = checkPrerequisites({ dshHome, profile: profile ?? target?.name })
  for (const item of prereq.items) {
    const state = item.found === true
      ? `已检测到${item.where.length ? `（${item.where.join('、')}）` : ''}`
      : item.found === false
        ? '**未检测到**'
        : '无法判定（没找到 profile 的 `cordis.patch.yml`）'
    // "怎么配"只在**真没检测到**时才说 —— 已经配好了还念一遍配置方法，读着像没配
    const detail = item.found === false ? `${state}\n       ${item.fix}` : state
    add(item.found !== false || !item.required, `${item.required ? '必需' : '可选'} MCP：${item.label}`, detail)
  }

  const alternatives = npxDshCandidates()
  return { ok: checks.every((c) => c.ok), checks, dsh, alternatives }
}
