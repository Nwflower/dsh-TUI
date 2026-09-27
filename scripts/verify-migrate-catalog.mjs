/**
 * verify-migrate-catalog — 外部来源浏览层回归（合成 fixture，临时目录，不读本机数据）。
 *
 * 覆盖 docs/foreign-session-tabs-design.md §3、§5、§7：扫描 IO 基础设施
 * （有界头尾窗口、异步遍历、指纹复用）、四个源的 scan()/load()（摘要与
 * 全量解析一致、sessionKey 等于 discover() 的 sourceId）、来源探测、
 * catalog 缓存与快照、单会话导入。
 *
 * 运行：node --import tsx/esm scripts/verify-migrate-catalog.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checks = 0
function check(name, ok, extra = '') {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

const scratch = mkdtempSync(join(tmpdir(), 'verify-migrate-catalog-'))

// ── 1. 扫描 IO 基础设施 ─────────────────────────────────────────────────
{
  const { readHead, readTail, walkFiles, runScan, withHead, loadText, MAX_ARTIFACT_BYTES } =
    await import('../src/dsh-adapter/migrate/adapters/scan-fs.js')
  const file = join(scratch, 'lines.jsonl')
  // 每行 10 字节（含换行），末行无换行
  writeFileSync(file, ['汉字ab1', '汉字ab2', '汉字ab3'].join('\n'))
  check('1a. 头窗口只保留完整行（窗口在行中间时丢掉残行）', (await readHead(file, 14)) === '汉字ab1\n')
  check('1b. 尾窗口丢掉开头的残行', (await readTail(file, 14, 29)) === '汉字ab3')
  check('1c. 文件短于窗口时整读', (await readHead(file, 1024)).endsWith('汉字ab3'))
  const seen = []
  const accepted = await withHead(file, 29, (head, whole) => { seen.push(whole); return head.includes('ab3') ? 'found' : undefined })
  check('1d. withHead 在小文件上一次整读即返回', accepted === 'found' && seen.join() === 'true')

  const tree = join(scratch, 'tree')
  mkdirSync(join(tree, 'a', 'subagents'), { recursive: true })
  mkdirSync(join(tree, 'a', 'b', 'c', 'd'), { recursive: true })
  writeFileSync(join(tree, 'a', 'x.jsonl'), '')
  writeFileSync(join(tree, 'a', 'subagents', 'agent.jsonl'), '')
  writeFileSync(join(tree, 'a', 'b', 'c', 'd', 'deep.jsonl'), '')
  writeFileSync(join(tree, 'a', 'note.txt'), '')
  const names = []
  for await (const walked of walkFiles([tree, join(scratch, 'missing-root')], { maxDepth: 3, match: n => n.endsWith('.jsonl'), skipDirs: ['subagents'] })) {
    names.push(walked.name)
  }
  check('1e. 遍历按名字匹配、跳过指定目录、限制深度、缺失根目录不报错', names.join(',') === 'x.jsonl', names.join(','))

  const controller = new AbortController()
  controller.abort()
  let aborted = false
  try {
    for await (const _ of walkFiles([tree], { maxDepth: 3, match: () => true, signal: controller.signal })) { /* empty */ }
  } catch (error) {
    aborted = error?.name === 'AbortError'
  }
  check('1f. 已中止的 signal 让遍历以 AbortError 结束', aborted)

  const candidates = async function* () {
    yield { ref: 'r1', fp: { mtimeMs: 1, size: 1 } }
    yield { ref: 'r2', fp: { mtimeMs: 2, size: 2 } }
    yield { ref: 'r3', fp: { mtimeMs: 3, size: 3 } }
    yield { ref: 'r4', fp: { mtimeMs: 4, size: 4 } }
  }
  const summarized = []
  const reported = []
  const summary = ref => ({ agentId: 'x', sessionKey: ref, ref, title: ref, cwd: '', lastMessageAt: 0, createdAt: 0 })
  const entries = await runScan(candidates(), {
    cached: ref => ref === 'r1' ? summary('r1') : ref === 'r2' ? null : undefined,
    onEntry: s => reported.push(s.ref),
  }, async ({ ref }) => {
    summarized.push(ref)
    if (ref === 'r4') throw new Error('vanished')
    return summary(ref)
  })
  check('1g. 命中缓存的（含已知否定结果）不再读取，其余逐个摘要',
    summarized.join(',') === 'r3,r4' && entries.map(e => `${e.ref}:${e.summary === null ? 'null' : 'ok'}`).join(',') === 'r1:ok,r2:null,r3:ok')
  check('1h. 读取失败的条目本轮跳过、不缓存；onEntry 只报会话', reported.join(',') === 'r1,r3')
  check('1i. 全量读取：缺失文件报 missing', JSON.stringify(await loadText(join(scratch, 'nope.jsonl'))) === '{"skip":"missing"}'
    && MAX_ARTIFACT_BYTES === 64 * 1024 * 1024)
}

// ── 公共：假 HOME（adapter 经 os.homedir() 定位源目录；Windows 读 USERPROFILE）──
const home = join(scratch, 'home')
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GROK_HOME: process.env.GROK_HOME }
process.env.HOME = home
process.env.USERPROFILE = home
process.env.GROK_HOME = join(home, '.grok')
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
/** scan() 的结果按 sessionKey 排序后的 [sessionKey, title] 摘要，便于断言。 */
const keyed = entries => entries.filter(e => e.summary !== null).map(e => e.summary).sort((a, b) => a.sessionKey.localeCompare(b.sessionKey))

// ── 2. claude-code scan()/load() ────────────────────────────────────────
{
  const { claudeCodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/claude-code.js')
  const project = join(home, '.claude', 'projects', '-w-cc')
  mkdirSync(join(project, 'aaaa', 'subagents'), { recursive: true })
  const line = (sessionId, type, message, extra = {}) => ({ type, sessionId, cwd: '/w/cc', timestamp: '2026-09-01T00:00:00Z', message, ...extra })
  const conversation = (sessionId, prompt) => [
    line(sessionId, 'user', { role: 'user', content: prompt }),
    line(sessionId, 'assistant', { id: `m-${sessionId}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: '好的' }] }),
  ]
  writeFileSync(join(project, 'aaaa.jsonl'), jsonl([{ type: 'ai-title', aiTitle: '小会话标题', sessionId: 'aaaa' }, ...conversation('aaaa', '小会话提问')]))
  // 大会话：提问在头部，/rename 标题在 256KB 之后的尾部（改名追加，后到者胜）
  const filler = Array.from({ length: 400 }, (_, i) =>
    line('bbbb', 'assistant', { id: `f${i}`, role: 'assistant', content: [{ type: 'text', text: '填充'.repeat(400) }] }))
  writeFileSync(join(project, 'bbbb.jsonl'), jsonl([
    { type: 'custom-title', customTitle: '早期的名字', sessionId: 'bbbb' },
    ...conversation('bbbb', '大会话提问'), ...filler,
    { type: 'custom-title', customTitle: '最后的名字', sessionId: 'bbbb' },
  ]))
  writeFileSync(join(project, 'agent-aux.jsonl'), jsonl(conversation('aaaa', '辅助 transcript')))
  writeFileSync(join(project, 'aaaa', 'subagents', 'agent-1.jsonl'), jsonl(conversation('aaaa', '子代理')))
  writeFileSync(join(project, 'cccc.jsonl'), jsonl([line('cccc', 'user', { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' })]))

  const reported = []
  const entries = await claudeCodeAdapter.scan({ onEntry: s => reported.push(s.sessionKey) })
  const summaries = keyed(entries)
  check('2a. 只列出独立会话：辅助 transcript 与纯注入会话为 null，subagents/ 不遍历',
    summaries.map(s => s.sessionKey).join(',') === 'aaaa,bbbb' && entries.length === 4 && reported.length === 2,
    entries.map(e => `${e.ref.split(/[\\/]/).pop()}:${e.summary?.sessionKey ?? null}`).join(' '))
  check('2b. 摘要标题：小文件取 ai-title；大文件读尾窗口取最后一次 /rename',
    summaries[0].title === '小会话标题' && summaries[1].title === '最后的名字', summaries.map(s => s.title).join(' | '))
  const discovered = claudeCodeAdapter.discover().sessions.map(s => s.sourceId).sort()
  check('2c. scan 的 sessionKey 与 discover 的 sourceId 完全一致', JSON.stringify(summaries.map(s => s.sessionKey)) === JSON.stringify(discovered), discovered.join(','))
  check('2d. 摘要的 cwd/时间：cwd 取行上字段，lastMessageAt 为文件 mtime',
    summaries.every(s => s.cwd === '/w/cc' && s.lastMessageAt === entries.find(e => e.ref === s.ref).fp.mtimeMs))
  const loaded = await claudeCodeAdapter.load(summaries[1].ref)
  const full = claudeCodeAdapter.discover().sessions.find(s => s.sourceId === 'bbbb')
  check('2e. load(ref) 与 discover 的全量解析逐字段一致', JSON.stringify(loaded) === JSON.stringify(full))
  check('2f. load 不是会话的 ref → not-a-session；不存在的 ref → missing',
    (await claudeCodeAdapter.load(join(project, 'agent-aux.jsonl'))).skip === 'not-a-session'
    && (await claudeCodeAdapter.load(join(project, 'gone.jsonl'))).skip === 'missing')
  const rescanned = []
  await claudeCodeAdapter.scan({ cached: (ref, fp) => entries.find(e => e.ref === ref && e.fp.mtimeMs === fp.mtimeMs)?.summary, onEntry: s => rescanned.push(s.sessionKey) })
  check('2g. 指纹未变时整轮命中缓存（含否定结果）仍按会话回报', rescanned.sort().join(',') === 'aaaa,bbbb')
}

// ── 3. codex / grok-build / zcode scan()/load() ─────────────────────────
{
  const { codexAdapter } = await import('../src/dsh-adapter/migrate/adapters/codex.js')
  const { grokBuildAdapter } = await import('../src/dsh-adapter/migrate/adapters/grok-build.js')
  const { zcodeAdapter } = await import('../src/dsh-adapter/migrate/adapters/zcode.js')
  const discoveredKeys = adapter => adapter.discover().sessions.map(s => s.sourceId).sort()

  // codex：主 rollout（首问前有很大的 base_instructions，逼出第二级头窗口）+ 子代理 rollout
  const day = join(home, '.codex', 'sessions', '2026', '09', '01')
  mkdirSync(day, { recursive: true })
  const uuid = n => `0199aaaa-0000-7000-8000-00000000000${n}`
  const meta = (extra = {}) => ({ timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/w/codex', timestamp: '2026-09-01T00:00:00Z', base_instructions: '规则'.repeat(20000), ...extra } })
  const item = payload => ({ timestamp: '2026-09-01T00:00:01Z', type: 'response_item', payload })
  const ask = text => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>env</environment_context>' }, { type: 'input_text', text }] })
  writeFileSync(join(day, `rollout-2026-09-01T00-00-00-${uuid(1)}.jsonl`), jsonl([meta(), ask('Codex 主会话提问'), item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答' }] })]))
  writeFileSync(join(day, `rollout-2026-09-01T00-00-01-${uuid(2)}.jsonl`), jsonl([meta({ thread_source: 'subagent' }), ask('子代理任务')]))
  const codexEntries = await codexAdapter.scan()
  const codexSummaries = keyed(codexEntries)
  check('3a. codex：子代理 rollout 为 null；首问在 32KB 之外也能取到；注入块不进标题',
    codexEntries.length === 2 && codexSummaries.length === 1 && codexSummaries[0].title === 'Codex 主会话提问' && codexSummaries[0].cwd === '/w/codex',
    codexSummaries.map(s => s.title).join('|'))
  check('3b. codex：sessionKey 等于 discover 的 sourceId（文件名中的 uuid）',
    JSON.stringify(codexSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(codexAdapter)) && codexSummaries[0].sessionKey === uuid(1))
  check('3c. codex：load(ref) 与 discover 逐字段一致',
    JSON.stringify(await codexAdapter.load(codexSummaries[0].ref)) === JSON.stringify(codexAdapter.discover().sessions[0]))

  // grok：一个有真实提问的会话目录 + 一个只有注入的会话目录
  const grokSession = (id, rows, summary = {}) => {
    const dir = join(home, '.grok', 'sessions', '%2Fw%2Fgrok', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd: '/w/grok' }, created_at: '2026-09-01T00:00:00Z', ...summary }))
    writeFileSync(join(dir, 'chat_history.jsonl'), jsonl(rows))
    return dir
  }
  const grokDir = grokSession('grok-1', [
    { type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: '<user_query>Grok 提问</user_query>' }] },
    { type: 'assistant', content: '答', model_id: 'grok-x' },
  ], { session_summary: 'Grok 会话标题' })
  grokSession('grok-2', [{ type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] }])
  const grokEntries = await grokBuildAdapter.scan()
  const grokSummaries = keyed(grokEntries)
  check('3d. grok：一个目录一个条目，ref 是会话目录；只有注入的会话为 null；标题取 session_summary',
    grokEntries.length === 2 && grokSummaries.length === 1 && grokSummaries[0].ref === grokDir && grokSummaries[0].title === 'Grok 会话标题')
  check('3e. grok：sessionKey 等于 discover 的 sourceId（info.id），load 与 discover 一致',
    JSON.stringify(grokSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(grokBuildAdapter))
    && JSON.stringify(await grokBuildAdapter.load(grokDir)) === JSON.stringify(grokBuildAdapter.discover().sessions[0]))
  const before = grokEntries.find(e => e.ref === grokDir).fp
  writeFileSync(join(grokDir, 'summary.json'), JSON.stringify({ info: { id: 'grok-1', cwd: '/w/grok' }, session_summary: '改过的标题 更长一些' }))
  const after = (await grokBuildAdapter.scan()).find(e => e.ref === grokDir).fp
  check('3f. grok：指纹复合两个文件，只改 summary.json 也会失效', before.size !== after.size || before.mtimeMs !== after.mtimeMs)

  // zcode：{meta, messages} 文档 + 一个坏文档
  const zdir = join(home, '.zcode', 'v2', 'sessions', 'w')
  mkdirSync(zdir, { recursive: true })
  writeFileSync(join(zdir, 'task-9.json'), JSON.stringify({ meta: { taskId: 'task-9', workspacePath: '/w/zc', title: 'zcode 标题', createdAt: 1790000000000 }, messages: [{ role: 'user', content: 'zcode 提问' }, { role: 'assistant', content: '答' }] }))
  writeFileSync(join(zdir, 'broken.json'), '{')
  const zcEntries = await zcodeAdapter.scan()
  const zcSummaries = keyed(zcEntries)
  check('3g. zcode：整读解析，坏文档为 null；sessionKey 等于 meta.taskId，load 与 discover 一致',
    zcEntries.length === 2 && zcSummaries.length === 1 && zcSummaries[0].title === 'zcode 标题' && zcSummaries[0].createdAt === 1790000000000
    && JSON.stringify(zcSummaries.map(s => s.sessionKey)) === JSON.stringify(discoveredKeys(zcodeAdapter))
    && JSON.stringify(await zcodeAdapter.load(zcSummaries[0].ref)) === JSON.stringify(zcodeAdapter.discover().sessions[0]))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
rmSync(scratch, { recursive: true, force: true })
console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate catalog regression passed (${checks} checks)`)
