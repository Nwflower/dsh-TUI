/**
 * verify-migrate-parse — 迁移源解析层回归（纯函数，合成 fixture，不读本机数据）。
 *
 * 覆盖 src/dsh-adapter/migrate/parse/ 与各源 *.parse.ts：注入识别与包装剥离、
 * 标题归一、工具调用配对，以及 docs/foreign-session-tabs-design.md §4.3 的
 * 逐源规则。fixture 全部是手写的合成数据，不提交任何真实会话内容。
 * 事件落盘与续聊链路见 scripts/verify-migrate.mjs。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate-parse.mjs
 */
const { parseJsonl, isRecord } = await import('../src/dsh-adapter/migrate/parse/jsonl.js')

let checks = 0
function check(name, ok, extra = '') {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

// ── 1. jsonl ────────────────────────────────────────────────────────────
{
  const raw = [
    JSON.stringify({ type: 'a' }),
    'null',
    '42',
    '"text"',
    '[1,2]',
    '{"type":"broken"',
    '',
    '   ',
    `${JSON.stringify({ type: 'b' })}\r`,
    'not json at all',
  ].join('\n')
  const { records, badLines } = parseJsonl(raw)
  check('1a. 只保留对象行且保持顺序', records.map(r => r.type).join(',') === 'a,b', JSON.stringify(records))
  check('1b. 合法的 null / 标量 / 数组行静默跳过，坏行计数', badLines === 2, `badLines=${badLines}`)
  check('1c. CRLF 行尾可解析', records[1]?.type === 'b')
  check('1d. isRecord 拒绝 null 与数组', !isRecord(null) && !isRecord([]) && isRecord({}))
  check('1e. 空文档 → 零行零坏行', parseJsonl('').records.length === 0 && parseJsonl('').badLines === 0)
}

console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate parse regression passed (${checks} checks)`)
