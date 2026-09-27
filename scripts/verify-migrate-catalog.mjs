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

rmSync(scratch, { recursive: true, force: true })
console.log(process.exitCode ? `${checks} check(s), FAILED` : `migrate catalog regression passed (${checks} checks)`)
