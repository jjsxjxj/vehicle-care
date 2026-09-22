# -*- coding: utf-8 -*-
"""D1 语句静态体检：SQL 里的 ?N 最大编号，是否等于 .bind() 传的参数个数。

为什么需要它：这类错位（少编一个号、多传一个值）不会在构建期暴露，
只有用户真的走到那条分支，才会收到
  D1_ERROR: Wrong number of parameter bindings for SQL query.
2026-09-21 车辆的 PATCH 分支就是这么挂的——UPDATE 只编到 ?11 却 .bind() 了 12 个值，
而当时的 E2E 只测过「新建」，所以一直没被发现。

用法（在项目根目录）:
  python tools/check-sql-bindings.py
输出: 每个语句一行 ok/MISMATCH；发现 MISMATCH 时退出码为 1，可直接接进 CI。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")


def scan_strings(text, i):
    """从 i 开始，把 prepare( 内拼接的字符串字面量拼起来，返回 (sql, 结束位置)。"""
    parts = []
    n = len(text)
    while i < n and text[i] not in "`'\"":
        if text[i] == ')':
            return ''.join(parts), i
        i += 1
    while i < n and text[i] in "`'\"":
        q = text[i]
        i += 1
        buf = []
        while i < n:
            c = text[i]
            if c == "\\":
                buf.append(text[i:i + 2])
                i += 2
                continue
            if c == q:
                i += 1
                break
            if q == '`' and c == '$' and i + 1 < n and text[i + 1] == '{':
                depth, j = 1, i + 2
                while j < n and depth:
                    if text[j] == '{':
                        depth += 1
                    elif text[j] == '}':
                        depth -= 1
                    j += 1
                buf.append('${...}')
                i = j
                continue
            buf.append(c)
            i += 1
        parts.append(''.join(buf))
        while i < n and text[i] in ' \t\r\n':
            i += 1
        if i < n and text[i] == '+':
            i += 1
            while i < n and text[i] in ' \t\r\n':
                i += 1
            continue
        break
    return ''.join(parts), i


def match_paren(text, i):
    """text[i] 是 '('，返回配对 ')' 的下标，找不到返回 -1。"""
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "`'\"":
            q = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    break
                i += 1
            i += 1
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def split_args(s):
    """按顶层逗号切分 .bind() 的参数。"""
    out, depth, cur, i, n = [], 0, [], 0, len(s)
    while i < n:
        c = s[i]
        if c in "`'\"":
            q = c
            cur.append(c)
            i += 1
            while i < n:
                cur.append(s[i])
                if s[i] == "\\":
                    if i + 1 < n:
                        cur.append(s[i + 1])
                    i += 2
                    continue
                if s[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ',' and depth == 0:
            out.append(''.join(cur).strip())
            cur = []
            i += 1
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            while i < n and s[i] != '\n':
                i += 1
            continue
        cur.append(c)
        i += 1
    if ''.join(cur).strip():
        out.append(''.join(cur).strip())
    return [a for a in out if a and not a.startswith('//')]


def main():
    if not os.path.isdir(SRC):
        print("找不到 src/ 目录: %s" % SRC)
        return 2
    bad = ok = dyn = 0
    for fn in sorted(os.listdir(SRC)):
        if not fn.endswith('.js'):
            continue
        text = io.open(os.path.join(SRC, fn), encoding='utf-8').read()
        for m in re.finditer(r'\.prepare\s*\(', text):
            p = text.index('(', m.start())
            sql, _ = scan_strings(text, p + 1)
            close = match_paren(text, p)
            if close < 0:
                continue
            tail = text[close + 1: close + 200]
            bm = re.match(r'\s*\.\s*bind\s*\(', tail)
            if not bm:
                continue
            bstart = close + 1 + bm.end()
            bend = match_paren(text, bstart - 1)
            args = split_args(text[bstart:bend])
            if '${...}' in sql:
                dyn += 1
                continue
            ph = [int(x) for x in re.findall(r'\?(\d+)', sql)]
            if not ph:
                continue
            line_no = text[:m.start()].count('\n') + 1
            if max(ph) != len(args):
                bad += 1
                print("MISMATCH %s:%d  占位符最大 ?%d，bind 传了 %d 个" % (fn, line_no, max(ph), len(args)))
                print("    SQL: " + ' '.join(sql.split())[:160])
            else:
                ok += 1
    print("")
    print("对上 %d 处，对不上 %d 处，动态拼装跳过 %d 处（需人工看一眼）" % (ok, bad, dyn))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
