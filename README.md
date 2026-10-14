# dsh-test-framework

> 面向**测试工程师**的 DSH 插件：把一个空文件夹变成你自己的「测试工作框架」，并在 AI 会话里
> **自动带上框架约束**、把「需求文档 → 子模块拆分 → 版本 / 跨文档关联 / 测试环境账密」这条链
> 做成**绕不过去的闸门**。
>
> - 宿主是 **cordis 插件**，**零第三方依赖**（只用 Node 内置模块），**无前端构建步骤**
> - 插件版本：`0.2.5` ｜ 适配：DSH（`dsh.engines.dsh = "*"`）｜ Node ≥ 20

---

## 一、它解决什么问题

用 DSH 做需求测试时，反复出问题的是这几件事 —— 它们**不是能力问题，是纪律问题**：

| 痛点 | 本插件的处置 |
| --- | --- |
| 新建一个文件夹就要**手工搭一遍框架骨架**（AGENTS.md / skills / _templates / 产品级规范 / 目录联接） | `test_framework_init` 一条命令生成，**已存在即跳过、不覆盖** |
| 在 `<产品>\<模块>\` 这种**子目录**里开会话，框架根 `AGENTS.md` **静默不加载**（DSH 只认 `.git` 当项目根） | 初始化时建 `.git` 标记；并且插件**另注入一段实时状态**，没加载成也会明说 |
| 120 页的需求文档含 3 个子模块，AI **自己就拆了**或干脆不拆 | 探针给页数/章节/菜单命中 → 命中判据就**必须**用 `ask_user_question` 让用户确认，不许自作主张 |
| 某个业务逻辑其实写在**另一份需求文档**里，没人问过 | 闸门 `crossDocChecked`：**必须问过**（答"没有"要落 `relatedDocs: []`，缺 key = 没问过） |
| 需求文档路径不区分版本，测错版本全白干 | 闸门 `versionsConfirmed`，并在流程里写死"不许用文件时间判版本" |
| 每次都要重新问一遍环境地址、账号密码、数据库地址 | `test_framework_record` 落**产品级规范**（人读的 md + 机器读的 json），下次直接命中 |
| 密码散落到脚本和报告里 | 明文**只落 `_框架配置\环境与账密.md`**，`框架登记.json` 里只记指针（有测试守着） |
| 报告越堆越多，模块 `report\` 里几个月前的报告还混在最新一批里 | `test_framework_report_gc`：满 24h 的报告移进 `_archive\报告归档\<模块>\<日期>\`（**归档不是删除**，台账记着原名与日期）；agent 入口**默认只预演** |
| 报告写成"密密麻麻一大长篇"，看不出有几条、最严重的是哪条、差在需求哪一句 | `AGENTS.md` 铁律 4 + 测试报告模板**硬性要求**：结论先行 + 缺陷速览表在最前 + 一条缺陷一小节（≤20 行）+ 复现步骤可照做 + **每条写「需求原文依据」与「与需求不符点」** |
| 一个模块测了好几版，几版的口径/造数逻辑/坑**全揉在一份 `SKILL.md` 里**，用的时候不知道哪句对哪版 | 模块 `SKILL.md` 降为**索引**，每版一份 `skill\<版本>\SKILL.md`，**一版一份、多版并存、互不覆盖**；`test_framework_module_add` 传 `version` 就自动建好并回填索引 §8 版本索引 |

---

## 二、装插件

### 路线 A：从 npm 装（别人用这条）

```powershell
# DSH 插件就是 npm 包 —— `dsh plugin ...` 本身就是转发给 pnpm
dsh plugin --profile desktop add dsh-test-framework

# 重启 DSH（profile 的 bundles 层与 cordis.patch.yml **不支持热加载**，不重启不生效）
```

装完看会话里有没有 `test_framework_status` 工具，或跑：

```powershell
npx dsh-test-framework doctor --profile desktop
```

### 路线 B：从源码装（改代码时用这条）

```powershell
cd <插件目录>
# ① 看计划（不写盘）
node lib\cli.js install --profile desktop

# ② 真装（链接安装：`link:` + 目录联接，不跑 pnpm）
node lib\cli.js install --profile desktop --apply

# ③ 重启 DSH
```

自检：

```powershell
node lib\cli.js doctor --profile desktop
```

`doctor` 会逐项报：插件清单 / 入口 / `cordis.patch.yml` / Node 版本 / 找不找得到 `dsh` 与 `pnpm` /
这个 profile 里**依赖与 bundles 两处是不是都有**（只有一处 = 半装 = 不会加载）。

### 可选配置

```yaml
# profile 的 cordis.patch.yml —— 把需求文档总根目录固定下来
- id: test-framework
  config:
    reqDocRoot: '<你的需求文档总根目录>'
```

不配也可以：省略时按「插件配置 → 环境变量 `DSH_REQ_DOC_ROOT` → `<用户主目录>\需求业务文档`」解析。
**插件里没有写死任何绝对路径**（有测试守着这一条）。

### 默认为什么**不**跑 `dsh plugin add`

默认走的是「**链接安装**」：备份 `package.json` → 给 `dependencies` 和 `dsh.profile.bundles`
各加一条 → 在 `node_modules` 里建一个**目录联接**。`link:` 依赖的本质就是这个联接，
所以这条路和 pnpm 的产出等价，但**不碰整棵 `node_modules`**。

`dsh plugin add` 会在 profile 目录里**真跑一次 `pnpm install`**。实测本机 desktop profile 的
`node_modules\@deepseek-ai` 处于**两个 dsh 版本混链**的状态（`profiles\node_modules` 下
`0.1.1-rc.2` 与 `0.1.5-rc.3` 混着指），一次 `pnpm install` 很可能把这棵树"规范化"掉、
**连带影响正在运行的 DSH**。装一个小插件不值得冒这个险。

要用官方命令（或补跑 pnpm）：

```powershell
# 官方命令：会真跑 pnpm install
node ...\cli.js install --profile desktop --apply --official
# 链接安装 + 之后再补跑一次 pnpm install
node ...\cli.js install --profile desktop --apply --pnpm
```

### 关于本机有多个 `dsh`

本机 npx 缓存里有 **4 个** dsh（`0.2.0-rc.2` / `0.1.7-rc.1` / `0.1.5-rc.3` / `0.1.1-rc.2`），
而 profile 的 `node_modules` 是混链的。所以 `doctor` / `install` 挑 dsh 的顺序是
**PATH → 这个 profile 自己链的那个 → npm 全局 → npx 缓存（版本降序）**，并把候选全列出来；
要指定就 `--dsh <dsh.cmd 路径>`。

（找 profile 自己链的那个时**要查两层**：`<profile>\node_modules` 与
`<dshHome>\profiles\node_modules` —— 本机 `@deepseek-ai\dsh` 挂在**上一层**，只查自己那层会挑错版本。）

**怎么确认真装上了**：重启后新开一个会话，看 skill 列表里有没有 `test-framework-onboard`、
工具列表里有没有 `test_framework_status`；或直接说一句"看下测试框架状态"。
（本次装到 `desktop` profile 后**无需重启就已生效**：会话的 skill 目录里已出现 4 个
`test-framework*` skill，`dsh --profile desktop --dump-config` 里能看到 `- id: test-framework`。）

### 卸载

```powershell
node lib\cli.js uninstall --profile desktop
```

只摘掉 profile 的依赖与 `dsh.profile.bundles` 条目（改前**一定先备份**成 `package.json.bak-testfw-<日期>`），
并摘掉手动建的那个目录联接（不然会留下一个指向已卸载插件的死链接）。
**不动框架工作区里的任何文件** —— 卸载插件 ≠ 删框架。

---

## 三、装完能得到什么

### 3.1 六个工具

| 工具 | 干什么 |
| --- | --- |
| `test_framework_status` | **开工前先调它**。返回框架根、产品与模块、登记到哪一步、**还缺哪些项**。`ready: false` 时不许直接开测 |
| `test_framework_init` | 把（空的）文件夹初始化成框架骨架。`dryRun: true` 只看计划 |
| `test_framework_module_add` | 新增一个模块（= 系统里的一个**顶级菜单**）：建 `requirement/final/report/data/skill` + 渲染**模块索引** `SKILL.md` + 传 `version` 时再建 `skill\<版本>\SKILL.md`（**一版一份，互不覆盖**）并回填索引 §8 版本索引，最后**同时**回填框架根 `AGENTS.md` §三 与产品级 `模块路由.md` |
| `test_framework_record` | 登记**需求文档**（版本/页数/拆分/关联文档/取消项核对）与**测试环境与账密**，落产品级规范 |
| `test_framework_doc_probe` | **零依赖**探一份 docx：页数（优先 Word 自己记的 `Pages`）、章节树、表格、图片数、**带删除线的段落数**、疑似子模块、命中的顶级菜单，以及**拆分判定** |
| `test_framework_report_gc` | **报告回收**：把满 N 小时（默认 24）的报告从模块 `report\` 移进 `_archive\报告归档\<模块>\<日期>\`。**默认 `dryRun: true` 只预演**，确认后传 `dryRun: false` 才真搬。它**不重写归档逻辑** —— 只是去找并调用框架里那份 `archive_reports.py`，所以不存在"两套规则打架" |

### 3.2 四个 runtime skill（自动加载）

| skill | 什么时候命中 |
| --- | --- |
| `test-framework` | 测试框架总契约：三层结构、目录约定、12 条铁律摘要、闸门表 |
| `test-framework-init` | 「初始化测试框架」「把空文件夹变成测试框架」 |
| **`test-framework-onboard`** | **「测这份需求文档」「新版需求」「要不要拆」「测试环境地址/账号密码」** —— 这就是那条强制引导流程 |
| `test-framework-module` | 「新增模块」「这个功能算哪个模块」 |

> ⚠️ runtime skill 的 rank 是 **250**；**项目级** skill（`<框架根>\skills\<同名>\SKILL.md`，rank 100）会覆盖它。
> 也就是说：你在自己框架里写的同名 skill 永远优先，插件不跟你抢。

### 3.3 一段系统提示词 + 两个斜杠命令

- **系统提示词段落**：每次组装提示词时求值，把「框架根有没有 `.git`」「哪个产品还缺哪几项登记」
  实时摆到模型面前。**空的时候返回空字符串**，不占上下文。
  > 这是"闸门拦得住人"的关键：产品级/模块级规范**不会被自动加载**，光靠 `AGENTS.md` 拦不住。
- `/tf-status`、`/tf-gate`：等价于查状态，**不消耗模型回轮**（结果不进模型历史）。

---

## 四、引导流程长什么样（`test-framework-onboard`）

需求文档动辄 100+ 页，模型不可能整篇读进来。流程刻意设计成「先出结论 → 人确认 → 再动手」：

```
① test_framework_status            先认账，看缺什么
   定位需求文档（不许猜路径）
② test_framework_doc_probe         页数 / 章节 / 菜单命中 / 删除线段落 → 拆分判定（命中任一判据就停下来问）
     A 页数 > 100
     B 一/二级标题里有 ≥2 个独立业务功能名
     C 正文里有 ≥2 个不同的顶级菜单名   ← 最硬的判据，基本不误报
     D 用户口述里有并列词（"包含/以及/里面还有"）
   → ask_user_question 摆出「建议拆分方案 + 依据（章节号/页数区间）」等用户确认
③ 跨文档关联：问"本地还有哪些需求文档跟它有关联"（答没有要落 []）
④ 版本确认：问"本次测的是哪一版"（不许用文件时间判版本）
⑤ 环境与账密：页面地址 + 账号密码 + 数据库地址/账号密码 + 数据地址
⑥ test_framework_module_add × N（每个子模块一次）
⑦ test_framework_record（文档 + 环境）
⑧ test_framework_status 返回 ready: true 才允许开测
```

**范例**（用户自己举的例子）：需求文档写的是「**药品联动保障**」，正文里同时有 **缺药登记** +
**短缺评估** + **余缺调拨** → 必须拆成三个模块，各一个 `SKILL.md`、各一套 `requirement/final/report/data`。
需求原文只存一份，各模块 `SKILL.md` §9 用相对路径引用它。

**闸门口径**（这是判"问没问过"的唯一依据）：

| 字段 | 缺 key / 空 | 有值 |
| --- | --- | --- |
| `split` | `[]` 或没有 = **拆分未确认** | 模块名数组 + `splitConfirmed: true` |
| `relatedDocs` | **缺 key** = 跨文档关联**还没问过** | `[]` = 问过了、答"没有"；有值 = 关联文档的**本地绝对路径** |
| `version` | 空 = 版本未确认 | 如 `2606`、`2606beta3` |
| `environments[]` | 空 = 环境未登记 | 至少一个环境 + 对应库账密 |

---

## 五、文件说明

```
_plugin\dsh-test-framework\
├── package.json              清单：main / bin / exports / dsh.bundle.patch（成为 profile layer 的唯一凭据）
├── cordis.patch.yml          bundle patch：insert: [{ id: test-framework, name: 'dsh-test-framework' }]
├── README.md                 本文
├── lib\
│   ├── index.js              cordis 宿主入口：注册 4 skill + 6 工具 + 1 提示词段落 + 2 命令
│   ├── skills.js             4 个 runtime skill 的**正文**（跟着插件走，任何工作区都能用）
│   ├── tools.js              6 个工具定义（**手写 ToolDefinition**，不 import defineTool）
│   ├── framework.js          框架根识别 / 状态与闸门 / 框架登记读写 / 脚手架 / 模块登记（含**按版本建规范 + 回填 §8 版本索引**）/ 表格 upsert
│   ├── report-gc.js          **报告回收**：定位框架里那份 `archive_reports.py` 并调用它（**不重写归档逻辑**）
│   ├── docx.js               **零依赖** docx 探针：zip 自己解、XML 自己解
│   ├── templates.js          {{KEY}} 渲染（未替换的 key 保留 + 告警，不静默吞掉）
│   ├── install.js            安装 / 卸载 / 体检（默认链接安装，官方 `dsh plugin add` 可选，**先备份**）
│   └── cli.js                命令行入口（init、status、probe、report-gc、install、uninstall、doctor）
├── templates\                生成到工作区的模板（AGENTS.md / README / 模块骨架 + **版本骨架** / 测试报告 / 框架级 skill / 产品级规范 / **报告回收脚本**）
└── test\
    ├── framework.test.mjs    32 条框架测试
    └── install.test.mjs      8 条装机测试（全部在临时假 DSH_HOME 上跑，绝不碰真 profile）
```

### 产出的框架工作区长这样

```
<框架根>\
├── AGENTS.md                 框架契约（DSH 自动读取，前提是根上有 .git）
├── README.md
├── skills\                   框架级 skill（DSH 自动发现）
├── .dsh\skills → ..\skills   **目录联接**，DSH 的 skill 发现入口
├── .git\                     **项目根标记**（DSH 的 findProjectRoot 只认 .git）
├── .dsh-test-framework.json  插件认框架根的标记
├── <产品>\
│   ├── _框架配置\            产品级规范：环境与账密 / 需求文档台账 / 模块路由 / 框架登记.json
│   ├── _冒泡测试\            冒泡测试规范 + archive_reports.py（报告回收脚本）
│   ├── _库结构\
│   └── <模块>\               SKILL.md（索引）+ skill\<版本>\SKILL.md（该版规范）+ requirement / final / report / data
├── _templates\
└── _archive\                 scripts / backups / outputs / **报告归档\<模块>\<日期>\**
```

---

## 六、边界（照实说，不含糊）

**做不到的 / 故意不做的**：

| 项 | 说明 |
| --- | --- |
| 解析**加密 docx** | 本机加密件是 OLE 容器，解密要 `msoffcrypto`（Python）。探针会**认出加密并给出处**（走框架级 `requirement-docs` skill），**不会假装读到了内容** |
| 解析**二进制 `.doc`** | 不是 zip，读不了；如实上报，建议另存为 `.docx` |
| 拆分方案**自动定案** | 不自动。命中判据只做一件事：**把 AI 摁住，让它去问用户** |
| 多步表单 UI | DSH 斜杠命令**只收裸文本**，且结果不进模型历史；真 UI 要 `dsh.client` + 槽位，而官方客户端构建工具链未随包发布。所以引导靠 **skill 正文 + `ask_user_question`** |
| 热加载 | 装完/改完 `cordis.patch.yml` **必须重启 DSH**（`dsh-web-app` 把 `hmr` 在 host plane 关掉了） |
| 覆盖已有内容 | 一律不覆盖。模块 `SKILL.md` 是**累积型文档**（框架铁律 9），要补内容请追加 |

**已知的实现取舍**：

- `lib/tools.js` **不 import `defineTool`** —— 插件常以 `link:` 安装（真实路径在 profile 之外），
  Node 解析不到 profile 里的 `node_modules\@deepseek-ai\*`。所以手写等价形状；
  `ToolRuntime.register()` 只强校验 `output.schema` + `output.render`，原始注册由工具自己校验参数。
- 同理，宿主入口**全部零静态 `@deepseek-ai/*` import**，服务一律用 `ctx.get(name)` 可选取 +
  方法名探测，每段注册外面包 `try/catch` —— **插件绝不能把 DSH 启动搞挂**。
- 注入的提示词正文会把 `{{` 打散成 `{ {`：`renderPrompt` 是**严格模式**，遇到未知 `{{变量}}` 会抛错。
- 登记函数（`recordDocuments` / `recordEnvironments`）**位置参数与对象参数两种都收** ——
  同模块里 `frameworkStatus` / `addModule` 用的是对象参数，两种形状并存太容易写错（开发中实际踩了两次）。

---

## 七、开发者自检

```powershell
cd <插件目录>
npm test                                                  # 40 条测试（32 框架 + 8 装机）
node lib\cli.js doctor --profile desktop                  # 环境体检
node lib\cli.js init --product "演示产品" --root .\tmp --dry-run   # 只看脚手架计划
node lib\cli.js probe "<任意 .docx 绝对路径>"              # 探一份真实需求文档
node lib\cli.js report-gc --dry-run                       # 先看会归档什么（不加 --dry-run 才真搬）
```

**框架测试 32 条**覆盖：脚手架完整性（含**版本骨架**与**报告回收脚本逐字节一致**）+
**生成物里没有没被替换的占位符** + **登记文件是合法 JSON**（Windows 反斜杠转义）
+ `框架登记.json` 被正确报成「本次新建」而不是「跳过」 + 不覆盖已有内容 + dryRun 不落盘 + 框架根识别 +
模块登记幂等且**不覆盖累积型 `SKILL.md`** + **闸门逐项拦住与放行**（含「`relatedDocs` 缺 key = 没问过」
「`[]` = 问过答没有」）+ **密码只落 md 不进 json** + 登记幂等 + **登记函数两种调用方式都行** +
表格 upsert 三种动作 + 渲染告警 + **全部模板只用已知占位符** + docx 探针（非 Office / 不存在 / OLE 加密）
+ zip 与 XML 基础件 + **skill/工具定义形状合法** + **skill 里提到的工具名都真的注册了**
（反向也查：每个工具都至少被某个 skill 提到）。

**（0.2.0 新增）版本化模块规范 4 条**：<br>
① `addModule` 带 `version` → 索引与 `skill\<版本>\SKILL.md` **两份都落**，且**索引 §8 版本索引自动补行**、§1「当前在测版本」跟着走；<br>
② **两版并存**：`2607` 新开一份，`2606` **逐字节不变**；同一版重复登记**不堆重复行**；<br>
③ 不给 `version` → **不建版本规范且必须显式告警**（不许静默少文件）；<br>
④ 模板自带「按版本分开」三件套（版本骨架含 §V1~§V6、模块骨架指向 `skill\<版本>\`、脚手架不漏搬子目录）。

**（0.2.0 新增）报告回收 5 条**：`productsWithScript` 只认**真落地了脚本**的产品 +
`planReportGc` 默认 `dryRun`、指到**落地脚本**、`--hours/--all` 透传、没脚本/没注入 `listProducts` 都**明确失败** +
`renderReportGc` 人类可读且原样带出脚本输出 + `runReportGc` **真跑一次 dry-run**（本机没 python 就明确 skip，
**不许假装通过**）+ `report_gc` 工具**描述与行为一致**（不传 `dryRun` 时规划出来必须带 `--dry-run`）。

**（0.2.0 新增）模板契约 2 条**：`AGENTS.md` / `README.md` 模板**不许再出现旧归档根 `_archive\冒泡测试\`**，
且必须写明版本化 skill 两层、报告硬要求（缺陷速览 / 需求原文依据 / 与需求不符点 / 复现步骤）。

**装机测试 8 条**（**全部在临时假 `DSH_HOME` 上跑，绝不碰真 profile**）：
`listProfiles` 只认有 `package.json` 的目录 + 找不到 profile / 没声明 `dsh.bundle.patch` 要报错 +
link 模式**先备份**、写依赖与 bundles、**建出的联接真能解析回插件目录** + **不动别人的依赖** +
幂等不堆重复项 + 认出「半装」状态 + 卸载摘干净（依赖 / bundles / 死链接）**但不动别人的依赖、不删备份** +
装机计划里必须写明「要重启」与「默认不跑 pnpm」。

> `npm test` 刻意用 `node test/*.mjs` 直跑，**不用 `node --test test/`** ——
> 后者会给每个文件起子进程，在受限沙箱里会撞上 `spawn EPERM`。

---

## 八、变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-10-14 | 0.2.5 | **补上模板里"列了却没发"的两个产品级文件**。`templates\AGENTS.md` 的目录树一直列着 `_冒泡测试\` 下三件套，但 `templates\产品\_冒泡测试\` 里**只有 `archive_reports.py`** —— 于是别人初始化出来的框架少了《冒泡测试规范.md》（怎么按模块测，28 KB）与 `bubble_db.py`（连库预检 / 只读核对 / 按主键清理），得自己补。<br>**脱敏后才发**：两份源文件里带作者环境的信息共 24 处，逐处替换并**断言每处命中一次**（不命中就报错，不静默漏改）—— 真实 host / 库名 / schema / 表前缀 / **库账号密码**（在 `bubble_db.py` 的 docstring 示例里）、客户名与产品示例、"221" 这类内部环境代号、以及**框架根绝对路径**，全部换成 `<DB_HOST>` `<SCHEMA>` `<产品A>` 这类占位符；遍历清单与缺陷示例里的模块名也一并占位化。<br>**顺带修正**：`bubble_db.py` 的 `--schema` 默认值从作者库的 schema 改为 `public`；《冒泡测试规范》里补了一句"报告归档的计划任务**插件不会自动创建**，需自行建（没建也能手动跑）"。<br>**验证**：`python -m py_compile` 通过；扫 30 个敏感词**零命中**；`framework.test.mjs` + `install.test.mjs` 全绿。 |
| 2026-10-14 | 0.2.4 | **修一个真 bug + 补上让它溜过去的守卫漏洞**。`lib\framework.js` 里**还留着一处写死的个人绝对路径**（`addModule` 渲染模块骨架时那一处 `REQ_DOC_ROOT`），于是 **0.2.0~0.2.3 四版发出去的包里都有它** —— 别人装完建模块，生成的 `SKILL.md` 里会带上**作者机器上的路径**。<br>**为什么守卫没拦住**：0.2.1 加的那条"扫源码找写死路径"的测试，正则只认**单反斜杠** `D:\Users\...`，而源码里是**双反斜杠转义** `'D:\\Users\\...'` —— 永远匹配不上，所以它一路绿着。<br>**三处修正**：① 写死路径改为 `defaultReqDocRoot()`；② 两条扫描统一**先把连续反斜杠压成一个**再比对（转义形态再也骗不过去）；③ 扫描范围从"只扫 `lib` 与 `templates`"扩到**整个包**。<br>**验证方式**：把写死路径重新注入一次，确认两道守卫都会变红，再还原。 |
| 2026-10-14 | 0.2.3 | **修正变更记录本身**：0.2.1 那条把被替换掉的产品名**原文写了出来**，等于又泄了一次（脱敏时只扫了源码与模板，没扫 README 的说明文字）。现已改为不点名。**教训**：脱敏的复扫范围必须包含「描述脱敏过程的那段文字」。 |
| 2026-10-14 | 0.2.2 | **开源到 GitHub**：[liujianqiao701/dsh-test-framework](https://github.com/liujianqiao701/dsh-test-framework)，并打上 `dsh-plugin` 等 12 个 topic（社区插件市场就是按 **GitHub topic `dsh-plugin`** 抓取的）。`package.json` 补 `repository` / `homepage` / `bugs`，npm 页面与仓库互链。 |
| 2026-10-14 | 0.2.1 | **脱敏**：清掉插件里所有**客户/项目/地域标识** —— 系统目录名与产品名示例换成 `系统A / 系统B` 与 `示例产品`，业务 schema 名换成占位，测试数据里的地名换成「某地」。**保留** `缺药登记` / `药品联动保障` / `短缺评估` / `余缺调拨` 这类**行业通用**业务词 —— 它们是"一个顶级菜单下三个子功能"的范例，不指向具体客户。<br>⚠️ `0.2.0` 因含上述标识已被 **deprecate**；npm 的 granular token（绕过 2FA）无权 `unpublish`，**删除需包主本人带 2FA 在网页端操作**。 |
| 2026-10-14 | 0.2.0 | **发布到 npm 公开仓库**：`dsh-test-framework@0.2.0`，`dsh plugin --profile <名字> add dsh-test-framework` 即可装。<br>**上架前修掉两处**：① `package.json` 的 `private: true`（这个开关会直接拒绝发布）已去掉，补 `publishConfig` / LICENSE / 关键词；② **需求文档总根目录不再写死**作者盘符 —— 解析顺序改为「显式参数 → 插件配置 `config.reqDocRoot` → 环境变量 `DSH_REQ_DOC_ROOT` → `<用户主目录>\需求业务文档`」，并加了一条**扫源码与模板**的测试（正则 `[A-Za-z]:\\Users\\<名字>\\需求业务文档`），从根上挡住"作者的个人路径被发到别人机器上"。<br>**注**：DSH 侧并**没有**插件市场 —— 全树搜 `marketplace` 零命中，"设置 → 插件"只是本地 Loader 快照；`dsh plugin ...` 本身只是转发给 pnpm，所以 npm 就是分发渠道。已有的"连接器市场"是 **MCP 连接器**货架，与本插件不是一类东西，且只能本机上下架、无法从那里上传。<br>**验证**：从 npm 下载 tarball（shasum `b0ce82ca…`，28 文件）解开后跑它自带的测试 —— **41/41 通过**（33 框架 + 8 装机）。 |
| 2026-10-13 | 0.2.0 | **报告与规范两件事**（按用户要求"报告要一目了然""报告超 24 小时自动清除""skill 规范按版本区分，不要所有 skill 融在一个版本"）。<br>**① 模块规范按版本分开**：模块 `SKILL.md` 降为**索引**（定位 / 公共约定 / §8 版本索引），每个版本一份 `skill\<版本>\SKILL.md`（§V1~§V6），**一版一份、多版并存、互不覆盖**。`addModule` 新增 `version` 参数：建 `skill\` 子目录、渲染版本规范、**自动往索引 §8 追加一行**、同步 §1「当前在测版本」；不给 `version` 会**显式告警**而不是静默少文件。模板新增 `模块骨架\skill\版本骨架\SKILL.md`。<br>**② 报告回收**：新增工具 `test_framework_report_gc` + `lib\report-gc.js`，把满 24h（可调）的报告从模块 `report\` 移进 `_archive\报告归档\<模块>\<日期>\`；范围从"只扫冒泡报告"放宽到 `report\` 下全部 `*.md`（`_` 开头与无日期的常驻文档默认跳过，`all: true` 才收）。**刻意不重写归档逻辑** —— 只是定位并调用框架里那份 `archive_reports.py`，避免"两套规则打架"；agent 入口默认 `dryRun: true`（只看不动），CLI 默认真归档。<br>**③ 报告写法硬要求**进了 `AGENTS.md` 铁律 4 与测试报告模板：结论先行 + **缺陷速览表放在最前**、一条缺陷一小节（≤20 行）、复现步骤 `1./2./3.` 可照做、**每条必须写「需求原文依据」（文档名+章节号+原文引用）与「与需求不符点」**、大段日志落 `data\` 只写路径。<br>测试 30 → **40 条**（22 → 32 框架 + 8 装机）。 |
| 2026-10-13 | 0.1.0 | 首个版本：5 工具 / 4 skill / 1 提示词段落 / 2 命令 / CLI（init、status、probe、install、uninstall、doctor）/ 30 条测试（22 框架 + 8 装机）。<br>装机默认改为**链接安装**（不跑 pnpm），绕过本机 profile `node_modules` 混版本的风险；dsh 挑选按「PATH → profile 链的那个 → npm 全局 → npx 缓存（版本降序）」—— profile 的 `@deepseek-ai` 挂在**上一层** `profiles\node_modules`，两层都要查。<br>实测已装进 `desktop` profile 并生效：会话 skill 目录出现 4 个 `test-framework*`，`dsh --dump-config` 出现 `- id: test-framework`，`test_framework_status` 可调用；空目录 → 搭框架 → 加 3 模块 → 登记文档与环境 → 闸门放行，全链路实测通过。<br>**修**：① 脚手架把「本次由模板循环写下的 `框架登记.json`」误报成「跳过（已存在）」，现在按「本次是否真写过」区分；② `recordDocuments` / `recordEnvironments` 原本是位置参数、而 `frameworkStatus` / `addModule` 是对象参数，两种形状并存极易写错（开发中实际踩了两次）—— 现在**两种调用方式都收**；③ 卸载时会摘掉手动建的目录联接，不留死链接。 |
