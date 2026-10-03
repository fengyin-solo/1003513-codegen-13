import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 汛前检查派工的业务层：候选缆道、派工单生命周期，以及
// 「派工单 + 站房受托任务 + 巡检现场确认」三处事务写入。
// 页面不直接改数据，全部走这里，和 local-service 的约定一致。

const DISPATCH_KEY = 'dispatch'
const CABLEWAY_KEY = 'cableway'
const STATIONHOUSE_KEY = 'stationhouse'
const INSPECTION_KEY = 'inspection'

// 未结派工单状态：这些状态下的工单会占用缆道，同一条缆道不能同时进两张未结工单。
const OPEN_STATUSES = ['待审核', '已派工', '执行中']

// 允许留白的字段：退回待审核时会清空审核人，重新审核时再填。
const OPTIONAL_FIELDS = new Set(['审核人'])

export type DispatchItem = {
  id: number
  缆道编号: string
  所属站点: string
  管理单位: string
  跨度米数: string
  荷载能力: string
  最近检修日: string
}

export type Candidate = {
  row: EntryRow
  reason: string // 进入候选的原因：需检修 / 无检修记录
  lockedBy: string // 已被未结派工单占用的单号，空串表示可勾选
}

export type DispatchView = {
  row: EntryRow
  items: DispatchItem[]
}

type Write = { key: string; rows: EntryRow[]; added: EntryRow[]; label: string }

// 事务提交：逐组校验、逐组写入；任何一组失败就把已写的组全部恢复成提交前的快照。
function commitAll(writes: Write[]): string | null {
  const snapshots = writes.map((write) => ({ key: write.key, rows: cloneRows(listRows(write.key)) }))
  try {
    for (const write of writes) {
      const problem = validateAdded(write)
      if (problem) {
        throw new Error(problem)
      }
      saveRows(write.key, write.rows)
    }
    return null
  } catch (error) {
    for (const snapshot of snapshots) {
      try {
        saveRows(snapshot.key, snapshot.rows)
      } catch {
        // 回滚本身失败没有更多补救手段，至少保证内存态停在快照上
      }
    }
    return error instanceof Error ? error.message : '写入失败'
  }
}

// 新增行必填字段不能空：受托单位、巡检人员、计划日期缺了就算写入失败，触发整体回退。
function validateAdded(write: Write): string | null {
  for (const row of write.added) {
    for (const [field, value] of Object.entries(row)) {
      if (OPTIONAL_FIELDS.has(field)) {
        continue
      }
      if (typeof value === 'string' && value.trim() === '') {
        return `${write.label}的「${field}」为空`
      }
    }
  }
  return null
}

function cloneRows(rows: EntryRow[]): EntryRow[] {
  return JSON.parse(JSON.stringify(rows)) as EntryRow[]
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextOrderNo(orders: EntryRow[]): string {
  const year = new Date().getFullYear()
  let max = 0
  for (const order of orders) {
    const match = /^WO-\d+-(\d+)$/.exec(String(order['派工单号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `WO-${year}-${String(max + 1).padStart(4, '0')}`
}

export function toDispatchItem(row: EntryRow): DispatchItem {
  return {
    id: Number(row.id),
    缆道编号: String(row['缆道编号'] ?? ''),
    所属站点: String(row['所属站点'] ?? ''),
    管理单位: String(row['管理单位'] ?? '') || '未登记',
    跨度米数: String(row['跨度米数'] ?? ''),
    荷载能力: String(row['荷载能力'] ?? ''),
    最近检修日: String(row['最近检修日'] ?? ''),
  }
}

function parseItems(order: EntryRow): DispatchItem[] {
  try {
    const parsed = JSON.parse(String(order['缆道明细'] ?? '[]')) as DispatchItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function lockedCablewayMap(): Map<number, string> {
  const map = new Map<number, string>()
  for (const order of listRows(DISPATCH_KEY)) {
    if (!OPEN_STATUSES.includes(String(order.status))) {
      continue
    }
    for (const item of parseItems(order)) {
      map.set(item.id, String(order['派工单号']))
    }
  }
  return map
}

// 候选规则：状态「需检修」的缆道必进候选；没有最近检修日的在役老缆道也纳入候选——
// 汛前检查的目的就是找出从没检修过的老缆道，漏掉它们风险更大，这里标「无检修记录」
// 交给值班员勾选时权衡。检修中、已停用的不进候选。
export function listCandidates(): Candidate[] {
  const locked = lockedCablewayMap()
  const result: Candidate[] = []
  for (const row of listRows(CABLEWAY_KEY)) {
    const status = String(row.status)
    if (status === '检修中' || status === '已停用') {
      continue
    }
    const noRecord = String(row['最近检修日'] ?? '').trim() === ''
    const reason = status === '需检修' ? '需检修' : noRecord ? '无检修记录' : ''
    if (!reason) {
      continue
    }
    result.push({ row, reason, lockedBy: locked.get(Number(row.id)) ?? '' })
  }
  return result
}

export function listDispatches(): DispatchView[] {
  return listRows(DISPATCH_KEY).map((row) => ({ row, items: parseItems(row) }))
}

// 值班员整组生成派工单：同组只能是同一管理单位，已被未结工单占用的缆道不能重复派工。
export function createDispatch(input: {
  cablewayIds: number[]
  受托单位: string
  巡检人员: string
  计划检修日期: string
  创建人: string
}): ActionResult {
  if (input.cablewayIds.length === 0) {
    return { ok: false, message: '请先勾选至少一条待检修缆道' }
  }
  if (!input.受托单位.trim() || !input.巡检人员.trim() || !input.计划检修日期.trim()) {
    return { ok: false, message: '受托单位、巡检人员、计划检修日期都要填写' }
  }
  const candidates = listCandidates()
  const items: DispatchItem[] = []
  for (const id of input.cablewayIds) {
    const candidate = candidates.find((item) => Number(item.row.id) === id)
    if (!candidate) {
      return { ok: false, message: `缆道 ${id} 不在候选范围，可能已停用或正在检修` }
    }
    if (candidate.lockedBy) {
      return { ok: false, message: `缆道 ${candidate.row['缆道编号']} 已在派工单 ${candidate.lockedBy} 里，不能重复派工` }
    }
    items.push(toDispatchItem(candidate.row))
  }
  const units = new Set(items.map((item) => item.管理单位))
  if (units.size !== 1) {
    return { ok: false, message: '同组派工只能选择同一管理单位的缆道' }
  }
  const orders = listRows(DISPATCH_KEY)
  const 单号 = nextOrderNo(orders)
  const order: EntryRow = {
    id: nextId(orders),
    status: '待审核',
    pending: true,
    abnormal: false,
    派工单号: 单号,
    管理单位: items[0].管理单位,
    受托单位: input.受托单位.trim(),
    巡检人员: input.巡检人员.trim(),
    计划检修日期: input.计划检修日期,
    缆道数量: items.length,
    创建人: input.创建人.trim() || '值班员',
    审核人: '',
    派工状态: '待审核',
    缆道明细: JSON.stringify(items),
  }
  saveRows(DISPATCH_KEY, [...orders, order])
  return { ok: true, message: `派工单 ${单号} 已生成（${items.length} 条缆道），等待审核派工` }
}

// 审核人调整派工单：只有待审核能调；已派工、已执行的不能回退再改。
export function adjustDispatch(
  id: number,
  patch: {
    受托单位?: string
    巡检人员?: string
    计划检修日期?: string
    addCablewayIds?: number[]
    removeCablewayIds?: number[]
  },
): ActionResult {
  const orders = listRows(DISPATCH_KEY)
  const order = orders.find((row) => Number(row.id) === id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (String(order.status) !== '待审核') {
    return { ok: false, message: `派工单 ${order['派工单号']} 已派工，已执行项目不能回退调整` }
  }
  let items = parseItems(order)
  const removeSet = new Set(patch.removeCablewayIds ?? [])
  if (removeSet.size > 0) {
    items = items.filter((item) => !removeSet.has(item.id))
  }
  for (const cablewayId of patch.addCablewayIds ?? []) {
    if (items.some((item) => item.id === cablewayId)) {
      continue
    }
    const candidate = listCandidates().find((item) => Number(item.row.id) === cablewayId)
    if (!candidate) {
      return { ok: false, message: `缆道 ${cablewayId} 不在候选范围，不能补进派工单` }
    }
    if (candidate.lockedBy) {
      return { ok: false, message: `缆道 ${candidate.row['缆道编号']} 已在派工单 ${candidate.lockedBy} 里` }
    }
    const item = toDispatchItem(candidate.row)
    if (item.管理单位 !== String(order['管理单位'])) {
      return { ok: false, message: `缆道 ${item.缆道编号} 属于 ${item.管理单位}，同组只能是 ${order['管理单位']}` }
    }
    items.push(item)
  }
  if (items.length === 0) {
    return { ok: false, message: '派工单至少要保留一条缆道' }
  }
  const updated: EntryRow = {
    ...order,
    受托单位: (patch.受托单位 ?? String(order['受托单位'])).trim(),
    巡检人员: (patch.巡检人员 ?? String(order['巡检人员'])).trim(),
    计划检修日期: (patch.计划检修日期 ?? String(order['计划检修日期'])).trim(),
    缆道数量: items.length,
    缆道明细: JSON.stringify(items),
  }
  if (!updated['受托单位'] || !updated['巡检人员'] || !updated['计划检修日期']) {
    return { ok: false, message: '受托单位、巡检人员、计划检修日期都要填写' }
  }
  saveRows(
    DISPATCH_KEY,
    orders.map((row) => (Number(row.id) === id ? updated : row)),
  )
  return { ok: true, message: `派工单 ${order['派工单号']} 已调整，仍为待审核` }
}

// 审核派工：一次提交写三处——派工单转「已派工」、站房维护记录新增受托任务、
// 巡检记录新增现场确认。重复确认只保留一套：已派工的工单直接返回成功，不再重复生成；
// 任一写入未成功，三处全部回退到提交前。
export function confirmDispatch(id: number, 审核人: string): ActionResult {
  const orders = listRows(DISPATCH_KEY)
  const order = orders.find((row) => Number(row.id) === id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  const status = String(order.status)
  if (status !== '待审核') {
    if (status === '已派工') {
      return { ok: true, message: `派工单 ${order['派工单号']} 已确认过，关联任务只保留一套，未重复生成` }
    }
    return { ok: false, message: `派工单 ${order['派工单号']} 已执行，不能回退重新确认` }
  }
  if (!审核人.trim()) {
    return { ok: false, message: '请填写审核人' }
  }
  const items = parseItems(order)
  if (items.length === 0) {
    return { ok: false, message: '派工单里没有缆道，不能提交' }
  }
  const 单号 = String(order['派工单号'])
  const houseRows = listRows(STATIONHOUSE_KEY)
  const inspectionRows = listRows(INSPECTION_KEY)
  // 幂等：同单号的关联任务已存在就不重复生成，只保留最早那一套。
  const houseExists = houseRows.some((row) => String(row['关联派工单'] ?? '') === 单号)
  const inspectionExists = inspectionRows.some((row) => String(row['关联派工单'] ?? '') === 单号)

  const addedHouse: EntryRow[] = []
  if (!houseExists) {
    let seq = nextId(houseRows)
    for (const item of items) {
      addedHouse.push({
        id: seq,
        status: '待安排',
        pending: true,
        abnormal: false,
        记录编号: `STAT-${String(seq).padStart(4, '0')}`,
        站点编号: item.所属站点,
        维护类型: '受托任务',
        维护内容: `派工单${单号}：${item.缆道编号}汛前检修`,
        维护单位: String(order['受托单位']),
        维护日期: String(order['计划检修日期']),
        费用支出: 0,
        维护状态: '待安排',
        关联派工单: 单号,
      })
      seq += 1
    }
  }
  const addedInspection: EntryRow[] = []
  if (!inspectionExists) {
    let seq = nextId(inspectionRows)
    for (const item of items) {
      addedInspection.push({
        id: seq,
        status: '待巡检',
        pending: true,
        abnormal: false,
        记录编号: `INSP-${String(seq).padStart(4, '0')}`,
        站点编号: item.所属站点,
        巡检日期: String(order['计划检修日期']),
        巡检人员: String(order['巡检人员']),
        检查项目: '现场确认',
        发现问题: '—',
        处理措施: `派工单${单号}：${item.缆道编号}检修现场确认`,
        巡检状态: '待巡检',
        关联派工单: 单号,
      })
      seq += 1
    }
  }

  const updated: EntryRow = {
    ...order,
    status: '已派工',
    pending: true,
    审核人: 审核人.trim(),
    派工状态: '已派工',
  }
  const failure = commitAll([
    {
      key: DISPATCH_KEY,
      rows: orders.map((row) => (Number(row.id) === id ? updated : row)),
      added: [updated],
      label: '派工单',
    },
    { key: STATIONHOUSE_KEY, rows: [...houseRows, ...addedHouse], added: addedHouse, label: '站房受托任务' },
    {
      key: INSPECTION_KEY,
      rows: [...inspectionRows, ...addedInspection],
      added: addedInspection,
      label: '巡检现场确认',
    },
  ])
  if (failure) {
    return { ok: false, message: `${failure}，三处写入已全部回退` }
  }
  return {
    ok: true,
    message: `派工单 ${单号} 已派工：站房受托任务 ${addedHouse.length} 项、现场确认 ${addedInspection.length} 项已同步生成`,
  }
}

// 退回调整：已派工 → 待审核，同时撤回还没开始的站房受托任务和现场确认；
// 已执行（执行中/已完成）的不能回退。
export function withdrawDispatch(id: number): ActionResult {
  const orders = listRows(DISPATCH_KEY)
  const order = orders.find((row) => Number(row.id) === id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  const status = String(order.status)
  if (status === '待审核') {
    return { ok: false, message: '派工单还在待审核，直接调整即可' }
  }
  if (status !== '已派工') {
    return { ok: false, message: `派工单 ${order['派工单号']} 已执行，不能回退` }
  }
  const 单号 = String(order['派工单号'])
  const houseRows = listRows(STATIONHOUSE_KEY)
  const inspectionRows = listRows(INSPECTION_KEY)
  const linkedHouse = houseRows.filter((row) => String(row['关联派工单'] ?? '') === 单号)
  const linkedInspection = inspectionRows.filter((row) => String(row['关联派工单'] ?? '') === 单号)
  const houseStarted = linkedHouse.some((row) => String(row.status) !== '待安排')
  const inspectionStarted = linkedInspection.some((row) => String(row.status) !== '待巡检')
  if (houseStarted || inspectionStarted) {
    return { ok: false, message: '关联任务已有进展，不能整单退回' }
  }
  const updated: EntryRow = { ...order, status: '待审核', 审核人: '', 派工状态: '待审核' }
  const failure = commitAll([
    {
      key: DISPATCH_KEY,
      rows: orders.map((row) => (Number(row.id) === id ? updated : row)),
      added: [updated],
      label: '派工单',
    },
    {
      key: STATIONHOUSE_KEY,
      rows: houseRows.filter((row) => String(row['关联派工单'] ?? '') !== 单号),
      added: [],
      label: '站房受托任务',
    },
    {
      key: INSPECTION_KEY,
      rows: inspectionRows.filter((row) => String(row['关联派工单'] ?? '') !== 单号),
      added: [],
      label: '巡检现场确认',
    },
  ])
  if (failure) {
    return { ok: false, message: `${failure}，三处写入已全部回退` }
  }
  return { ok: true, message: `派工单 ${单号} 已退回待审核，关联的受托任务与现场确认已撤回` }
}

// 开始执行：派工单 → 执行中，整组缆道 → 检修中。
export function startExecution(id: number): ActionResult {
  const orders = listRows(DISPATCH_KEY)
  const order = orders.find((row) => Number(row.id) === id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (String(order.status) !== '已派工') {
    return { ok: false, message: '只有已派工的工单才能开始执行' }
  }
  const itemIds = new Set(parseItems(order).map((item) => item.id))
  const nextCableways = listRows(CABLEWAY_KEY).map((row) =>
    itemIds.has(Number(row.id)) ? { ...row, status: '检修中', pending: true, 缆道状态: '检修中' } : row,
  )
  const updated: EntryRow = { ...order, status: '执行中', 派工状态: '执行中' }
  const failure = commitAll([
    {
      key: DISPATCH_KEY,
      rows: orders.map((row) => (Number(row.id) === id ? updated : row)),
      added: [updated],
      label: '派工单',
    },
    { key: CABLEWAY_KEY, rows: nextCableways, added: [], label: '测流缆道' },
  ])
  if (failure) {
    return { ok: false, message: `${failure}，写入已回退` }
  }
  return { ok: true, message: `派工单 ${order['派工单号']} 开始执行，整组缆道已转检修中` }
}

// 完成执行：派工单 → 已完成，整组缆道 → 正常运行并登记最近检修日。
export function completeExecution(id: number): ActionResult {
  const orders = listRows(DISPATCH_KEY)
  const order = orders.find((row) => Number(row.id) === id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (String(order.status) !== '执行中') {
    return { ok: false, message: '只有执行中的工单才能办结' }
  }
  const today = new Date().toISOString().slice(0, 10)
  const itemIds = new Set(parseItems(order).map((item) => item.id))
  const nextCableways = listRows(CABLEWAY_KEY).map((row) =>
    itemIds.has(Number(row.id))
      ? { ...row, status: '正常运行', pending: false, abnormal: false, 缆道状态: '正常运行', 最近检修日: today }
      : row,
  )
  const updated: EntryRow = { ...order, status: '已完成', pending: false, 派工状态: '已完成' }
  const failure = commitAll([
    {
      key: DISPATCH_KEY,
      rows: orders.map((row) => (Number(row.id) === id ? updated : row)),
      added: [updated],
      label: '派工单',
    },
    { key: CABLEWAY_KEY, rows: nextCableways, added: [], label: '测流缆道' },
  ])
  if (failure) {
    return { ok: false, message: `${failure}，写入已回退` }
  }
  return { ok: true, message: `派工单 ${order['派工单号']} 已办结，整组缆道恢复正常运行` }
}
