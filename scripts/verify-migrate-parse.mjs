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

// ── 2. 注入识别与包装剥离 ───────────────────────────────────────────────
{
  const { isInjectedText, unwrapUserText, stripSystemReminders, isInterruptNotice } =
    await import('../src/dsh-adapter/migrate/parse/injection.js')
  const injected = [
    '<environment_context>\n  <cwd>/tmp/x</cwd>\n</environment_context>',
    '  <system-reminder>提醒</system-reminder>',
    '<USER_INSTRUCTIONS>大写也算</USER_INSTRUCTIONS>',
    '<local-command-caveat>Caveat</local-command-caveat>',
    '<local-command-stdout>ok</local-command-stdout>',
    '<command-name>/model</command-name>',
    '<permissions>…</permissions>',
    '<user_info>OS: linux</user_info>',
    '# AGENTS.md instructions for /tmp/x\n\n<INSTRUCTIONS>…',
    '# Context from my IDE setup:\n\n## Open tabs',
  ]
  const missed = injected.filter(text => !isInjectedText(text))
  check('2a. 注入前缀表逐条命中（大小写不敏感、允许前导空白）', missed.length === 0, missed.join(' | '))
  check('2b. 真实提问不误判（正文中间出现标签不算注入）',
    !isInjectedText('请看 <system-reminder> 这个标签') && !isInjectedText('# 标题\n正文'))
  check('2c. <user_query> 只留正文', unwrapUserText('<user_query>\n修一下构建\n</user_query>') === '修一下构建')
  check('2d. 中断包装只留 <user_query> 正文',
    unwrapUserText('The user interrupted the previous turn: stop.\n<user_query>换个思路</user_query>') === '换个思路')
  check('2e. 插话包装只留 <user_query> 正文',
    unwrapUserText('The user sent a message while you were working:\n<user_query>顺便加测试</user_query>') === '顺便加测试')
  check('2f. 无 <user_query> 的包装去掉通知行首',
    unwrapUserText('The user sent a message while you were working: 顺便加测试') === '顺便加测试')
  check('2g. 未闭合的 <user_query> 取到末尾', unwrapUserText('<user_query>半截') === '半截')
  check('2h. 粘贴信封去标签留正文（含无闭标签形态）',
    unwrapUserText('看这段 <pasted_content id="p1">A\nB</pasted_content id="p1"> 怎么改') === '看这段 A\nB 怎么改'
    && unwrapUserText('<pasted_content id="p2">只有开标签') === '只有开标签')
  check('2i. 纯文本快速路径原样（仅去首尾空白）', unwrapUserText('  普通提问  ') === '普通提问')
  check('2j. system-reminder 行内剥离（多段、未闭合吞到末尾）',
    stripSystemReminders('前<system-reminder>a</system-reminder>中<system-reminder>b</system-reminder>后') === '前中后'
    && stripSystemReminders('正文<system-reminder>未闭合') === '正文')
  check('2k. 中断通知识别', isInterruptNotice('The user interrupted the previous turn: x') && !isInterruptNotice('interrupted'))
  // 线性扫描守卫：大量未闭合开标签不应退化为二次方
  const hostile = '<system-reminder>'.repeat(20000)
  const started = performance.now()
  stripSystemReminders(hostile)
  unwrapUserText('<user_query>'.repeat(20000))
  const elapsed = performance.now() - started
  check('2l. 敌意输入（2 万个未闭合开标签）线性完成', elapsed < 500, `${elapsed.toFixed(1)}ms`)
}

console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate parse regression passed (${checks} checks)`)
