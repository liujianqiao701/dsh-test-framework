# -*- coding: utf-8 -*-
"""冒泡测试用的数据库工具：环境预检 / 数据核对 / 按主键清理自造数据。

配合产品级《冒泡测试规范.md》使用。连接参数一律命令行传入，脚本内不留任何账密。

用法：
  # 环境预检 + 关键表行数基线
  python bubble_db.py precheck --host <DB_HOST> --port 5432 --dbname <DB> ^
         --user <USER> --password <PWD> --schema <SCHEMA> [--out baseline.json]

  # 数据核对（**只允许 SELECT**）
  python bubble_db.py query --host ... --sql "select count(*) from <SCHEMA>.<表名>"

  # 收尾清理自造数据（**必须按主键**，不允许宽泛条件）
  python bubble_db.py cleanup --host ... --table <SCHEMA>.<表名> ^
         --key <主键列> --values 996000001,996000002
"""
import argparse
import datetime
import json
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

try:
    import psycopg2
except ImportError:
    print('缺少 psycopg2，请先 pip install psycopg2-binary')
    sys.exit(2)


def connect(a):
    return psycopg2.connect(host=a.host, port=a.port, dbname=a.dbname,
                            user=a.user, password=a.password, connect_timeout=10)


def show_table(cols, rows, limit=50):
    if not rows:
        print('  (0 行)')
        return
    srows = [[('' if v is None else str(v)) for v in r] for r in rows[:limit]]
    widths = [max(len(str(c)), *(len(r[i]) for r in srows)) for i, c in enumerate(cols)]
    sep = '  ' + '  '.join('-' * w for w in widths)
    print('  ' + '  '.join(str(c).ljust(widths[i]) for i, c in enumerate(cols)))
    print(sep)
    for r in srows:
        print('  ' + '  '.join(r[i].ljust(widths[i]) for i in range(len(cols))))
    if len(rows) > limit:
        print(f'  … 共 {len(rows)} 行，仅显示前 {limit} 行')


# ── precheck ────────────────────────────────────────────────────────────────
def cmd_precheck(a):
    print('=' * 78)
    print('冒泡测试 · 环境预检（数据库）')
    print('=' * 78)
    print(f'  目标: {a.host}:{a.port}/{a.dbname}  user={a.user}  schema={a.schema}')

    try:
        conn = connect(a)
    except Exception as e:
        print(f'\n❌ 数据库不可达: {e}')
        print('   → 停下来向用户确认地址/账号/密码，不要自己猜')
        return 1

    cur = conn.cursor()
    with conn.cursor() as c:
        c.execute('select version()')
        ver = c.fetchone()[0]
        c.execute('select current_database(), current_user, now()')
        db, usr, now = c.fetchone()
        c.execute("select nspname from pg_namespace where nspname not like 'pg_%' "
                  "and nspname <> 'information_schema' order by 1")
        schemas = [r[0] for r in c.fetchall()]

    print(f'\n✅ 数据库可达')
    print(f'  版本     : {ver[:80]}')
    print(f'  当前库/用户: {db} / {usr}')
    print(f'  时间     : {now}')
    print(f'  schema   : {", ".join(schemas)}')
    if a.schema not in schemas:
        print(f'  ⚠️ 指定的 schema "{a.schema}" 不在列表里 —— 请确认')

    # 关键表基线
    with conn.cursor() as c:
        c.execute('set statement_timeout = %s', (a.timeout * 1000,))
        if a.tables:
            names = [t.strip() for t in a.tables.split(',') if t.strip()]
            tables = [(a.schema, n.split('.')[-1]) for n in names]
        else:
            c.execute('select table_schema, table_name from information_schema.tables '
                      'where table_schema = %s order by table_name', (a.schema,))
            tables = c.fetchall()

    print(f'\n关键表行数基线（schema={a.schema}，共 {len(tables)} 张表）：')
    counts, failed = {}, []
    for sch, tbl in tables:
        fq = f'{sch}.{tbl}'
        try:
            with conn.cursor() as c:
                c.execute('set statement_timeout = %s', (a.timeout * 1000,))
                c.execute(f'select count(*) from "{sch}"."{tbl}"')
                counts[fq] = c.fetchone()[0]
        except Exception as e:
            conn.rollback()
            failed.append((fq, str(e)[:80]))

    for fq, n in sorted(counts.items(), key=lambda x: -x[1])[:40]:
        print(f'  {n:>12,}  {fq}')
    if len(counts) > 40:
        print(f'  … 其余 {len(counts) - 40} 张表见输出文件')
    for fq, err in failed:
        print(f'  {"失败":>12}  {fq}  ({err})')

    total = sum(counts.values())
    print(f'\n  合计 {len(counts)} 张表 / {total:,} 行')

    out = a.out or f'baseline-{datetime.datetime.now():%Y%m%d-%H%M}.json'
    payload = {'captured_at': str(now), 'host': a.host, 'port': a.port, 'dbname': db,
               'schema': a.schema, 'total_rows': total, 'counts': counts}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f'  基线已落盘: {os.path.abspath(out)}')
    print('  → 收尾时用这份基线核对"是否已还原"')

    cur.close()
    conn.close()
    return 0


# ── query（只读）───────────────────────────────────────────────────────────
def cmd_query(a):
    sql = (a.sql or '').strip().rstrip(';')
    head = sql.lstrip('(').lstrip().lower()
    if not (head.startswith('select') or head.startswith('with') or head.startswith('show')):
        print('❌ 本命令只允许 SELECT / WITH / SHOW（数据核对用途）。')
        print('   要改数据请用 cleanup（按主键）或另写脚本，并遵守"改动必还原"。')
        return 2
    try:
        conn = connect(a)
    except Exception as e:
        print(f'❌ 数据库不可达: {e}')
        return 1
    print(f'SQL: {sql}\n')
    try:
        with conn.cursor() as c:
            c.execute('set statement_timeout = %s', (a.timeout * 1000,))
            c.execute(sql)
            cols = [d[0] for d in c.description] if c.description else []
            rows = c.fetchall() if c.description else []
        show_table(cols, rows, a.limit)
        print(f'\n  返回 {len(rows)} 行')
    except Exception as e:
        print(f'❌ 执行失败: {e}')
        conn.close()
        return 1
    conn.close()
    return 0


# ── cleanup（按主键删）─────────────────────────────────────────────────────
def cmd_cleanup(a):
    keys = [k.strip() for k in a.values.split(',') if k.strip()]
    if not keys:
        print('❌ 必须提供 --values（逗号分隔的主键值）')
        return 2
    if len(keys) > 200:
        print(f'⚠️ 一次删除 {len(keys)} 条，确认这是自造数据？(>200 条已拒绝，请分批)')
        return 2
    try:
        conn = connect(a)
    except Exception as e:
        print(f'❌ 数据库不可达: {e}')
        return 1
    try:
        with conn.cursor() as c:
            c.execute(f'select count(*) from {a.table}')
            before = c.fetchone()[0]
            ph = ','.join(['%s'] * len(keys))
            c.execute(f'delete from {a.table} where "{a.key}" in ({ph})', keys)
            n = c.rowcount
            c.execute(f'select count(*) from {a.table}')
            after = c.fetchone()[0]
        conn.commit()
        print(f'表 {a.table}：{before:,} → {after:,}（删除 {n} 行，按 {a.key} 匹配 {len(keys)} 个值）')
        if n != len(keys):
            print(f'  ⚠️ 删除行数({n}) != 提供的键数({len(keys)})，请核对是否有多余键或键不匹配')
        print('  → 记得把这行写进报告的"我改过什么、是否已还原"')
    except Exception as e:
        conn.rollback()
        print(f'❌ 删除失败（已回滚）: {e}')
        conn.close()
        return 1
    conn.close()
    return 0


def main():
    p = argparse.ArgumentParser(description='冒泡测试数据库工具（预检/核对/清理）')
    sub = p.add_subparsers(dest='cmd', required=True)

    def common(sp):
        sp.add_argument('--host', required=True)
        sp.add_argument('--port', type=int, default=5432)
        sp.add_argument('--dbname', required=True)
        sp.add_argument('--user', required=True)
        sp.add_argument('--password', required=True)
        sp.add_argument('--schema', default='public', help='库 schema，按你的库填')
        sp.add_argument('--timeout', type=int, default=30, help='单条 SQL 超时（秒）')

    sp = sub.add_parser('precheck', help='环境预检 + 行数基线')
    common(sp)
    sp.add_argument('--tables', default='', help='只统计这些表（逗号分隔），缺省=整个 schema')
    sp.add_argument('--out', default='', help='基线 JSON 输出路径')
    sp.set_defaults(func=cmd_precheck)

    sp = sub.add_parser('query', help='执行只读查询')
    common(sp)
    sp.add_argument('--sql', required=True)
    sp.add_argument('--limit', type=int, default=50)
    sp.set_defaults(func=cmd_query)

    sp = sub.add_parser('cleanup', help='按主键清理自造数据')
    common(sp)
    sp.add_argument('--table', required=True)
    sp.add_argument('--key', required=True, help='主键列名')
    sp.add_argument('--values', required=True, help='逗号分隔的主键值')
    sp.set_defaults(func=cmd_cleanup)

    a = p.parse_args()
    sys.exit(a.func(a))


if __name__ == '__main__':
    main()
