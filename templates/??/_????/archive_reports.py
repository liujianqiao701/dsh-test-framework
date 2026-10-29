# -*- coding: utf-8 -*-
"""测试报告自动归档（回收机制）：满 N 小时的报告与证据移到 `_archive\\报告归档\\<模块>\\<日期>\\`。

由 Windows 计划任务每小时调用（见 `_冒泡测试\\冒泡测试规范.md` §11）。

用法：
    python archive_reports.py --dry-run          # 只看会动哪些文件（先跑这个！）
    python archive_reports.py                    # 真正归档
    python archive_reports.py --hours 48         # 改阈值（默认 24 小时）
    python archive_reports.py --all              # 连"常驻文档"一起归档（默认跳过，见下）
    python archive_reports.py --backfill-index   # 只按已归档内容补写索引，不搬文件
    python archive_reports.py --no-index         # 搬文件但不回写模块 SKILL.md

## 归档什么（2026-10-13 修订：从"只收冒泡报告"放宽到"收全部测试报告"）

用户口径：**报告不要一直堆在模块目录里，超过 24 小时自动清走**。

  ① `report\\` 下的**全部 `*.md`**；
  ② `data\\` 下的证据目录：`冒泡测试-*` 与 `需求测试-*`。

### 但有两类"常驻文档"必须留下（否则会把台账误当成一次性报告搬走）

  · 文件名以 `_` 开头（如 `_归档索引.md`、`_缺陷台账.md`）；
  · 文件名里**没有 8 位日期**、且**不以 `冒泡测试-` 开头**的 —— 例如 `缺陷跟踪.md`、`测试说明.md`。
    这类是**跨多轮一直在用的活文档**，搬走会打断工作流。

判定"是一次性测试报告"的正规做法就是按框架命名规范带日期：
`<模块>-<内容>-<yyyyMMdd>.md`。确实需要连常驻文档一起收，用 `--all` 显式打开。

`--dry-run` 会把**跳过的常驻文档**逐条打出来（带原因），不让人猜。

## 覆盖范围

遍历**框架根下所有产品目录**（`_` / `.` 开头的是辅助目录，`skills\\` 之类也不是产品，一并跳过）。
跨产品同名模块用 `<产品>__<模块>` 分开，两份证据绝不混进同一目录。

## 归档索引

模块 `SKILL.md` 里的报告/证据路径是**静态**的，满 24h 被搬走后必然失效。
所以每次归档**顺手回写**两处索引（**只追加，绝不覆盖**，框架铁律 9）：

  1. `<模块>\\SKILL.md` 末尾的「## 归档索引」段；
  2. `_archive\\报告归档\\<模块>\\_归档索引.md` —— 累积台账。

**怎么还原**：归档就是移动，没有删除。把文件从 `_archive\\报告归档\\<模块>\\<日期>\\`
搬回模块的 `report\\` 即可；台账里记着原始文件名与日期。
"""
import argparse
import datetime
import os
import re
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')

BT_DIR = os.path.dirname(os.path.abspath(__file__))            # ...\<产品>\_冒泡测试
PRODUCT_SELF = os.path.dirname(BT_DIR)                         # ...\<产品>
ROOT = os.path.dirname(PRODUCT_SELF)                           # 框架根
ARCH_ROOT = os.path.join(ROOT, '_archive', '报告归档')
LOG = os.path.join(ARCH_ROOT, '_archive.log')

REPORT_EXT = '.md'                       # 报告扩展名
BUBBLE_PREFIX = '冒泡测试-'               # 冒泡报告即使没日期也算一次性报告
DATA_PREFIXES = ('冒泡测试-', '需求测试-')  # 随报告产生的证据目录
DATE_RE = re.compile(r'(\d{8})')
INDEX_HDR = '## 归档索引（archive_reports.py 自动追加 · 勿手改）'
NOT_PRODUCT = {'skills', 'node_modules', 'dist', 'build'}


def log(msg, lines):
    lines.append(msg)
    print(msg)


def item_date(name, mtime):
    """优先用文件名里的 8 位日期，否则用文件修改时间的日期。"""
    m = DATE_RE.search(name)
    if m:
        try:
            return datetime.datetime.strptime(m.group(1), '%Y%m%d').date()
        except ValueError:
            pass
    return datetime.datetime.fromtimestamp(mtime).date()


def is_living_doc(name):
    """判断是不是"常驻文档"（跨轮一直用，不该被回收）。

    返回 None = 可以归档；返回字符串 = 跳过原因。
    """
    if name.startswith('_'):
        return '文件名以 _ 开头（台账/索引类）'
    if DATE_RE.search(name):
        return None                       # 带日期 = 一次性报告
    if name.startswith(BUBBLE_PREFIX):
        return None                       # 冒泡报告的老命名习惯，没日期也算一次性
    return '文件名里没有 8 位日期，判定为常驻文档'


def move(src, dst_dir, dry, lines):
    """移动；目标重名时顺延 `_dup` / `_dup2` …（不覆盖任何已存在的东西）。"""
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, os.path.basename(src))
    if os.path.exists(dst):
        base, ext = os.path.splitext(os.path.basename(src))
        i = 1
        while True:
            tag = '_dup' if i == 1 else '_dup%d' % i
            dst = os.path.join(dst_dir, '%s%s%s' % (base, tag, ext))
            if not os.path.exists(dst):
                break
            i += 1
    if dry:
        log('    [将会移动] %s  ->  %s' % (os.path.basename(src), dst_dir), lines)
        return True
    try:
        shutil.move(src, dst)
        log('    [已归档] %s  ->  %s' % (os.path.basename(src), dst_dir), lines)
        return True
    except Exception as e:
        log('    [失败] %s: %s' % (os.path.basename(src), e), lines)
        return False


def product_dirs():
    """框架根下所有产品目录（`_` / `.` 开头与 skills\\ 之类的一律排除）。"""
    out = []
    for d in sorted(os.listdir(ROOT)):
        if d.startswith('_') or d.startswith('.'):
            continue
        if d in NOT_PRODUCT:
            continue
        if os.path.isdir(os.path.join(ROOT, d)):
            out.append(d)
    return out


def module_dirs(product):
    """产品下的模块目录（`_` 开头的是产品级辅助目录，不是模块）。"""
    p = os.path.join(ROOT, product)
    return sorted(d for d in os.listdir(p)
                  if os.path.isdir(os.path.join(p, d)) and not d.startswith('_'))


def arch_key(product, module, dup_names):
    """归档落位的模块名。

    两个产品下**同名模块**会让 `_archive\\报告归档\\<模块>\\` 撞在一起，
    这时加产品前缀（`<产品>__<模块>`）并在日志里点名 —— 宁可多一节路径，
    也不许两份证据混进同一目录。
    """
    return '%s__%s' % (product, module) if module in dup_names else module


def write_index(module_dir, product, module, key, moved, when, dry, lines):
    """把本次归档写进 ①模块 SKILL.md 的「归档索引」段 ②归档区的 `_归档索引.md` 台账。

    对 SKILL.md **只做追加 / 段内插入，绝不整篇覆盖**（铁律 9：SKILL.md 是累积型文档）。
    """
    rel_rows = []
    for rel, abs_src in moved:
        m = DATE_RE.search(os.path.basename(abs_src))
        d8 = m.group(1) if m else datetime.datetime.fromtimestamp(
            os.path.getmtime(abs_src)).strftime('%Y%m%d')
        if rel.startswith('data'):
            n = sum(len(fs) for _, _, fs in os.walk(abs_src))
            rel_rows.append('- %s `%s\\`（%d 个文件）→ `_archive\\报告归档\\%s\\%s\\`'
                            % (when, rel, n, key, d8))
        else:
            rel_rows.append('- %s `%s` → `_archive\\报告归档\\%s\\%s\\`'
                            % (when, rel, key, d8))

    if dry:
        return rel_rows

    # ① 模块 SKILL.md
    skill = os.path.join(module_dir, 'SKILL.md')
    if os.path.isfile(skill):
        try:
            txt = open(skill, encoding='utf-8').read()
            add = [r for r in rel_rows if r not in txt]
            if add:
                if INDEX_HDR in txt:
                    head, sep, tail = txt.partition(INDEX_HDR)
                    block = sep + '\n' + '\n'.join(add) + '\n'
                    txt = head + block + tail.lstrip('\n')
                else:
                    txt = txt.rstrip('\n') + '\n\n' + INDEX_HDR + '\n' + '\n'.join(add) + '\n'
                open(skill, 'w', encoding='utf-8', newline='').write(txt)
                lines.append('    [索引] 已追加 %d 行到 %s\\SKILL.md' % (len(add), module))
        except Exception as e:
            lines.append('    [索引失败] %s\\SKILL.md: %s' % (module, e))

    # ② 归档区台账
    try:
        ledger = os.path.join(ARCH_ROOT, key, '_归档索引.md')
        os.makedirs(os.path.dirname(ledger), exist_ok=True)
        old = open(ledger, encoding='utf-8').read() if os.path.isfile(ledger) else ''
        add = [r for r in rel_rows if r not in old]
        if add:
            if not old:
                old = ('# %s · 归档索引\n\n> 由 `_冒泡测试\\archive_reports.py` 自动维护，'
                       '每次归档追加。产品：%s\n\n' % (key, product))
            open(ledger, 'w', encoding='utf-8', newline='').write(
                old.rstrip('\n') + '\n' + '\n'.join(add) + '\n')
    except Exception as e:
        lines.append('    [索引失败] %s\\_归档索引.md: %s' % (key, e))
    return rel_rows


def backfill(dry, lines):
    """按 `_archive\\报告归档\\` 现有内容补写模块 SKILL.md 的归档索引（不搬文件）。"""
    if not os.path.isdir(ARCH_ROOT):
        log('  归档区还不存在，无需补写。', lines)
        return 0
    n = 0
    for key in sorted(os.listdir(ARCH_ROOT)):
        p = os.path.join(ARCH_ROOT, key)
        if not os.path.isdir(p) or key.startswith('_'):
            continue
        product, module = None, key
        if '__' in key:
            product, module = key.split('__', 1)
        cand = None
        for pr in ([product] if product else product_dirs()):
            c = os.path.join(ROOT, pr, module)
            if os.path.isdir(c):
                cand, product = c, pr
                break
        if cand is None:
            log('  [跳过] %s —— 找不到对应模块目录' % key, lines)
            continue
        moved = []
        for date in sorted(os.listdir(p)):
            dp = os.path.join(p, date)
            if not os.path.isdir(dp):
                continue
            for f in sorted(os.listdir(dp)):
                fp = os.path.join(dp, f)
                moved.append((_rel_kind(fp), fp))
        rows = write_index(cand, product, module, key, moved,
                           '[历史归档]', dry, lines)
        n += len(rows)
        for r in rows:
            log('  ' + r, lines)
    return n


def _rel_kind(path):
    """判断归档条目原本是报告（report\\）还是证据目录（data\\）。

    注意报告文件名也可能以 `冒泡测试-` 开头，**不能靠前缀区分**，只能看是不是目录。
    """
    name = os.path.basename(path)
    return ('data\\' + name) if os.path.isdir(path) else ('report\\' + name)


def main():
    ap = argparse.ArgumentParser(description='测试报告归档（满 N 小时移到 _archive\\报告归档）')
    ap.add_argument('--hours', type=int, default=24, help='阈值小时数，默认 24')
    ap.add_argument('--dry-run', action='store_true', help='只看会动什么，不实际移动')
    ap.add_argument('--quiet', action='store_true', help='无待归档内容时不输出')
    ap.add_argument('--no-index', action='store_true', help='不回写模块 SKILL.md 归档索引')
    ap.add_argument('--all', action='store_true',
                    help='连"常驻文档"一起归档（默认跳过没日期的非冒泡报告与 _ 开头的文件）')
    ap.add_argument('--backfill-index', action='store_true',
                    help='只按归档区现有内容补写索引，不搬文件')
    args = ap.parse_args()

    now = datetime.datetime.now()
    cutoff = now - datetime.timedelta(hours=args.hours)
    lines = []

    log('=== 报告归档 %s（阈值 %dh，早于 %s 的归档%s）==='
        % (now.strftime('%Y-%m-%d %H:%M:%S'), args.hours,
           cutoff.strftime('%Y-%m-%d %H:%M'), '，含常驻文档' if args.all else ''),
        lines)
    log('框架根: %s' % ROOT, lines)

    if args.backfill_index:
        n = backfill(args.dry_run, lines)
        log('补写索引 %d 行%s' % (n, '（dry-run，未写入）' if args.dry_run else ''), lines)
        _dump_log(lines, args, n)
        return 0

    products = product_dirs()
    log('产品: %s' % ('、'.join(products) if products else '（未发现产品目录）'), lines)

    # 跨产品同名模块 → 归档加产品前缀，避免两份证据挤进同一目录
    seen = {}
    for pr in products:
        for md in module_dirs(pr):
            seen.setdefault(md, []).append(pr)
    dup_names = {m for m, prs in seen.items() if len(prs) > 1}
    for m in sorted(dup_names):
        log('  ⚠️ 模块名 %s 在多个产品下同时存在（%s）→ 归档用 `<产品>__%s` 分开'
            % (m, '、'.join(seen[m]), m), lines)

    total = 0
    skipped = []
    for product in products:
        for mod in module_dirs(product):
            module_dir = os.path.join(ROOT, product, mod)
            key = arch_key(product, mod, dup_names)
            moved = []

            # ① 报告：<模块>\report\*.md
            rep_dir = os.path.join(module_dir, 'report')
            if os.path.isdir(rep_dir):
                for f in sorted(os.listdir(rep_dir)):
                    p = os.path.join(rep_dir, f)
                    if not os.path.isfile(p) or not f.endswith(REPORT_EXT):
                        continue
                    reason = None if args.all else is_living_doc(f)
                    if reason:
                        skipped.append('%s/%s\\report\\%s —— %s' % (product, mod, f, reason))
                        continue
                    mt = os.path.getmtime(p)
                    if mt >= cutoff.timestamp():
                        continue
                    d = item_date(f, mt)
                    age = (now - datetime.datetime.fromtimestamp(mt)).total_seconds() / 3600
                    log('  [%s/%s] 报告 %s（%.1fh 前）' % (product, mod, f, age), lines)
                    if move(p, os.path.join(ARCH_ROOT, key, '%s' % d.strftime('%Y%m%d')),
                            args.dry_run, lines):
                        moved.append(('report\\' + f, p))

            # ② 证据目录：<模块>\data\冒泡测试-*\ 与 data\需求测试-*\
            data_dir = os.path.join(module_dir, 'data')
            if os.path.isdir(data_dir):
                for dname in sorted(os.listdir(data_dir)):
                    p = os.path.join(data_dir, dname)
                    if not os.path.isdir(p) or not dname.startswith(DATA_PREFIXES):
                        continue
                    mt = os.path.getmtime(p)
                    if mt >= cutoff.timestamp():
                        continue
                    d = item_date(dname, mt)
                    age = (now - datetime.datetime.fromtimestamp(mt)).total_seconds() / 3600
                    n = sum(len(fs) for _, _, fs in os.walk(p))
                    log('  [%s/%s] 证据目录 %s（%.1fh 前，%d 个文件）'
                        % (product, mod, dname, age, n), lines)
                    if move(p, os.path.join(ARCH_ROOT, key, '%s' % d.strftime('%Y%m%d')),
                            args.dry_run, lines):
                        moved.append(('data\\' + dname, p))

            if moved and not args.no_index:
                write_index(module_dir, product, mod, key, moved,
                            now.strftime('%Y-%m-%d %H:%M'), args.dry_run, lines)
            total += len(moved)

    if skipped:
        log('  以下常驻文档**跳过**（%d 个；要一起收就加 --all）:' % len(skipped), lines)
        for s in skipped:
            log('    · %s' % s, lines)

    if total == 0:
        if not args.quiet or skipped:
            log('  没有超过阈值的一次性报告或证据，无需归档。', lines)
    else:
        log('合计处理 %d 项' % total + ('（dry-run，未实际移动）' if args.dry_run else ''), lines)

    _dump_log(lines, args, total)
    return 0


def _dump_log(lines, args, total):
    """落日志（dry-run 不写；--quiet 且无内容也不写，避免计划任务每小时刷日志）。"""
    if args.dry_run or (args.quiet and total == 0):
        return
    try:
        os.makedirs(ARCH_ROOT, exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
    except Exception as e:
        print('  （日志写入失败：%s）' % e)


if __name__ == '__main__':
    sys.exit(main())
