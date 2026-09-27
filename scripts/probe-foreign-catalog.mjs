/**
 * probe-foreign-catalog — 外部来源浏览层性能探针（读本机真实数据，只读源；
 * 快照与导入都写进临时目录，不碰 ~/.dsh-tui 与 ~/.dsh）。不是有界测试，
 * 不登记 CI；数字用于 PR 描述与 docs/foreign-session-tabs-design.md §5.2 的
 * 性能目标对照：
 *   - 来源探测（按名字遍历四个来源）；
 *   - 冷扫（无快照）、热扫（指纹全部未变）、快照首帧（新实例同步读出列表）；
 *   - 单会话导入：每个来源取最近一条，load + sessionize + 官方持久化落盘。
 *
 * 运行：node --import tsx/esm scripts/probe-foreign-catalog.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ForeignCatalog } = await import('../src/dsh-adapter/migrate/catalog.js')
const { MIGRATION_ADAPTERS } = await import('../src/dsh-adapter/migrate/index.js')
const { importForeignSession } = await import('../src/dsh-adapter/migrate/import-one.js')
const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { Context } = await import('@deepseek-ai/cordis')

const scratch = mkdtempSync(join(tmpdir(), 'probe-foreign-catalog-'))
const file = join(scratch, 'foreign-catalog.v1.json')
const ms = start => `${(performance.now() - start).toFixed(0)}ms`
const rows = []

let start = performance.now()
const catalog = new ForeignCatalog(MIGRATION_ADAPTERS, file)
const sources = await catalog.refreshSources()
rows.push(['来源探测', sources.map(s => `${s.agentId}:${s.count}`).join(' '), ms(start)])

let total = 0
start = performance.now()
for (const source of sources) total += (await catalog.refreshSessions(source.agentId)).length
rows.push(['冷扫（无快照）', `${total} 个会话`, ms(start)])

start = performance.now()
for (const source of sources) await catalog.refreshSessions(source.agentId)
rows.push(['热扫（指纹未变）', `${total} 个会话`, ms(start)])

start = performance.now()
const reopened = new ForeignCatalog(MIGRATION_ADAPTERS, file)
const firstFrame = reopened.sources().reduce((sum, source) => sum + reopened.sessions(source.agentId).length, 0)
rows.push(['快照首帧（同步读出）', `${firstFrame} 个会话`, ms(start)])

const ctx = new Context()
const fiber = ctx.plugin(JsonlSessionPersistence, { root: join(scratch, 'sessions') })
for (let i = 0; i < 100 && ctx.get('sessionPersistence') === undefined; i++) await new Promise(resolve => setTimeout(resolve, 50))
const persistence = ctx.get('sessionPersistence')
for (const source of sources) {
  const newest = catalog.sessions(source.agentId)[0]
  if (newest === undefined) continue
  start = performance.now()
  const result = await importForeignSession(persistence, catalog.adapter(source.agentId), { sessionKey: newest.sessionKey, ref: newest.ref, cwd: '' }, { cwdExists: () => true })
  rows.push([`导入 ${source.agentId} 最近一条`, result.kind === 'ready' ? '成功' : `${result.kind}${'reason' in result ? `:${result.reason}` : ''}`, ms(start)])
}
await Promise.resolve(fiber.dispose()).catch(() => {})
rmSync(scratch, { recursive: true, force: true })

const width = Math.max(...rows.map(row => row[0].length))
for (const [name, detail, time] of rows) console.log(`${name.padEnd(width)}  ${time.padStart(7)}  ${detail}`)
