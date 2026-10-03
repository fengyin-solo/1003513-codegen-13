import { listRows, saveRows, saveRowsBatch } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 检修派工单的领域逻辑：候选挑选、整组派工、审核调整、提交联动，全部走这里，页面不做业务判断。
// 提交时派工单、站房维护记录、巡检记录三处整批写入，任一失败整体回退，不留半截数据。

const DISPATCH_KEY = 'dispatch'
const CABLEWAY_KEY = 'cableway'
const STATION_KEY = 'station'
const STATIONHOUSE_KEY = 'stationhouse'
const INSPECTION_KEY = 'inspection'

// 已执行是终态：之前的状态才允许调整，已执行的工单和已执行的缆道项目都不能回退。
const FINAL_STATUS = '已执行'
const OPEN_STATUSES = ['待审核', '已审核', '执行中']

export type DispatchCandidate = {
  id: number
  缆道编号: string
  所属站点: string
  管理单位: string
  跨度米数: string
  荷载能力: string
  最近检修日: string
  入选原因: string
}

export type DispatchAdjust = {
  removeCodes?: string[]
  计划检修日?: string
  审核人?: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function field(row: EntryRow, name: string): string {
  return String(row[name] ?? '')
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], fieldName: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = field(row, fieldName).match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// 站点名称 → 站点记录，用于把缆道的所属站点翻译成站点编号和管理单位。
function stationByName(): Map<string, EntryRow> {
  const map = new Map<string, EntryRow>()
  for (const row of listRows(STATION_KEY)) {
    map.set(field(row, '站点名称'), row)
  }
  return map
}

function managementUnitOf(cableway: EntryRow, stations: Map<string, EntryRow>): string {
  const station = stations.get(field(cableway, '所属站点'))
  return station ? field(station, '管理单位') : '未登记管理单位'
}

function stationCodeOf(stationName: string, stations: Map<string, EntryRow>): string {
  const station = stations.get(stationName)
  return station ? field(station, '站点编号') : '未登记'
}

function orderCodes(order: EntryRow): string[] {
  return field(order, '缆道清单').split('、').filter((code) => code !== '')
}

function executedCodes(order: EntryRow): string[] {
  return field(order, '已执行缆道').split('、').filter((code) => code !== '')
}

function findOrder(id: number): EntryRow | undefined {
  return listRows(DISPATCH_KEY).find((row) => Number(row.id) === id)
}

// 候选规则：状态「需检修」的必查；没有最近检修日的老缆道也纳入候选——汛前检查不留死角，
// 从没检修过的缆道正是风险点，单独标注「无检修记录」提醒值班员。已在未完成派工单里的缆道不再出现。
export function listCandidates(): DispatchCandidate[] {
  const stations = stationByName()
  const booked = new Set<string>()
  for (const order of listRows(DISPATCH_KEY)) {
    if (OPEN_STATUSES.includes(field(order, 'status'))) {
      for (const code of orderCodes(order)) {
        booked.add(code)
      }
    }
  }
  const candidates: DispatchCandidate[] = []
  for (const row of listRows(CABLEWAY_KEY)) {
    const code = field(row, '缆道编号')
    if (booked.has(code)) {
      continue
    }
    const lastMaintained = field(row, '最近检修日')
    let reason = ''
    if (field(row, 'status') === '需检修') {
      reason = lastMaintained ? '状态需检修' : '状态需检修 · 无检修记录'
    } else if (lastMaintained === '') {
      reason = '无检修记录（老缆道汛前必查）'
    }
    if (reason === '') {
      continue
    }
    candidates.push({
      id: Number(row.id),
      缆道编号: code,
      所属站点: field(row, '所属站点'),
      管理单位: managementUnitOf(row, stations),
      跨度米数: field(row, '跨度米数'),
      荷载能力: field(row, '荷载能力'),
      最近检修日: lastMaintained,
      入选原因: reason,
    })
  }
  return candidates
}

export function listDispatchOrders(): EntryRow[] {
  return [...listRows(DISPATCH_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

// 值班员整组派工：勾选的缆道必须同属一个管理单位，整组只生成一张派工单。
export function createDispatchOrder(cablewayIds: number[], operator: string): ActionResult {
  if (cablewayIds.length === 0) {
    return { ok: false, message: '请先勾选待检修的缆道' }
  }
  const candidates = listCandidates()
  const selected = candidates.filter((item) => cablewayIds.includes(item.id))
  if (selected.length !== cablewayIds.length) {
    return { ok: false, message: '部分勾选缆道已不在候选范围（可能已派工），请刷新后重新勾选' }
  }
  const units = [...new Set(selected.map((item) => item.管理单位))]
  if (units.length > 1) {
    return { ok: false, message: `同组派工只能选择同一管理单位，当前勾选了：${units.join('、')}` }
  }
  const orders = listRows(DISPATCH_KEY)
  const stations = [...new Set(selected.map((item) => item.所属站点))]
  const order: EntryRow = {
    id: nextId(orders),
    status: '待审核',
    pending: true,
    abnormal: false,
    派工单号: nextCode(orders, '派工单号', 'DISP'),
    管理单位: units[0],
    涉及站点: stations.join('、'),
    缆道数量: selected.length,
    缆道清单: selected.map((item) => item.缆道编号).join('、'),
    已执行缆道: '',
    计划检修日: today(),
    值班员: operator,
    审核人: '',
    派工状态: '待审核',
  }
  saveRows(DISPATCH_KEY, [...orders, order])
  return { ok: true, message: `已生成派工单 ${field(order, '派工单号')}，整组 ${selected.length} 条缆道，待审核` }
}

// 审核人调整派工单：可移出未执行的缆道、改计划检修日和审核人；已执行的项目锁定，不能回退。
// 工单已提交过的，下游的站房受托任务和巡检现场确认同步重建，重复确认只保留一套。
export function adjustDispatchOrder(id: number, changes: DispatchAdjust): ActionResult {
  const order = findOrder(id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (field(order, 'status') === FINAL_STATUS) {
    return { ok: false, message: '派工单已执行，不能回退调整' }
  }
  const removeCodes = changes.removeCodes ?? []
  const executed = executedCodes(order)
  const blocked = removeCodes.filter((code) => executed.includes(code))
  if (blocked.length > 0) {
    return { ok: false, message: `已执行项目不能回退：${blocked.join('、')}` }
  }
  const remaining = orderCodes(order).filter((code) => !removeCodes.includes(code))
  if (remaining.length === 0) {
    return { ok: false, message: '派工单至少保留一条缆道，全部移出请改用停用流程' }
  }
  const cableways = listRows(CABLEWAY_KEY)
  const stationsOf = remaining
    .map((code) => cableways.find((row) => field(row, '缆道编号') === code))
    .filter((row): row is EntryRow => row !== undefined)
    .map((row) => field(row, '所属站点'))
  const updated: EntryRow = {
    ...order,
    缆道清单: remaining.join('、'),
    缆道数量: remaining.length,
    涉及站点: [...new Set(stationsOf)].join('、'),
    计划检修日: changes.计划检修日?.trim() || field(order, '计划检修日'),
    审核人: changes.审核人?.trim() || field(order, '审核人'),
  }
  const nextOrders = listRows(DISPATCH_KEY).map((row) => (Number(row.id) === id ? updated : row))
  if (field(order, 'status') === '待审核') {
    saveRows(DISPATCH_KEY, nextOrders)
    return { ok: true, message: `派工单 ${field(order, '派工单号')} 已调整，剩余 ${remaining.length} 条缆道` }
  }
  // 已提交的工单调整后，下游两处一并重建，三处仍然整批写入。
  const downstream = buildDownstream(updated)
  try {
    saveRowsBatch({
      [DISPATCH_KEY]: nextOrders,
      [STATIONHOUSE_KEY]: downstream.stationhouse,
      [INSPECTION_KEY]: downstream.inspection,
    })
  } catch (error) {
    return { ok: false, message: `调整未写入：${errorMessage(error)}，派工单、站房维护记录、巡检记录三处均未改动` }
  }
  return { ok: true, message: `派工单 ${field(order, '派工单号')} 已调整，站房受托任务与现场确认已同步更新` }
}

// 审核通过并提交：一次提交联动三处——派工单转已审核、站房维护记录新增受托任务、
// 巡检记录新增现场确认。任一写入失败，三处全部回退。
export function submitDispatchOrder(id: number, reviewer: string): ActionResult {
  const order = findOrder(id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (field(order, 'status') !== '待审核') {
    return { ok: false, message: `派工单当前状态「${field(order, 'status')}」，不能重复提交` }
  }
  if (orderCodes(order).length === 0) {
    return { ok: false, message: '派工单里没有缆道，不能提交' }
  }
  const updated: EntryRow = {
    ...order,
    status: '已审核',
    派工状态: '已审核',
    审核人: reviewer || field(order, '审核人'),
  }
  const nextOrders = listRows(DISPATCH_KEY).map((row) => (Number(row.id) === id ? updated : row))
  const downstream = buildDownstream(updated)
  try {
    saveRowsBatch({
      [DISPATCH_KEY]: nextOrders,
      [STATIONHOUSE_KEY]: downstream.stationhouse,
      [INSPECTION_KEY]: downstream.inspection,
    })
  } catch (error) {
    return { ok: false, message: `提交失败：${errorMessage(error)}，派工单、站房维护记录、巡检记录三处均未写入` }
  }
  return {
    ok: true,
    message: `派工单 ${field(order, '派工单号')} 已提交：站房受托任务 ${downstream.addedTasks} 条、现场确认 ${downstream.addedConfirms} 条已同步写入`,
  }
}

// 开始执行：工单进入执行中，清单内缆道同步转为检修中。
export function startDispatchOrder(id: number): ActionResult {
  const order = findOrder(id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (field(order, 'status') !== '已审核') {
    return { ok: false, message: `派工单当前状态「${field(order, 'status')}」，不能开始执行` }
  }
  const codes = orderCodes(order)
  const updated: EntryRow = { ...order, status: '执行中', 派工状态: '执行中' }
  const nextOrders = listRows(DISPATCH_KEY).map((row) => (Number(row.id) === id ? updated : row))
  const nextCableways = listRows(CABLEWAY_KEY).map((row) =>
    codes.includes(field(row, '缆道编号'))
      ? { ...row, status: '检修中', 缆道状态: '检修中' }
      : row,
  )
  try {
    saveRowsBatch({ [DISPATCH_KEY]: nextOrders, [CABLEWAY_KEY]: nextCableways })
  } catch (error) {
    return { ok: false, message: `开始执行失败：${errorMessage(error)}，派工单与缆道状态均未改动` }
  }
  return { ok: true, message: `派工单 ${field(order, '派工单号')} 开始执行，${codes.length} 条缆道转入检修中` }
}

// 逐条确认执行：缆道转正常运行并记下最近检修日；全部执行完工单自动转已执行（终态，不能回退）。
export function executeDispatchItem(id: number, code: string): ActionResult {
  const order = findOrder(id)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修派工单` }
  }
  if (field(order, 'status') !== '执行中') {
    return { ok: false, message: `派工单当前状态「${field(order, 'status')}」，不能确认执行` }
  }
  if (!orderCodes(order).includes(code)) {
    return { ok: false, message: `缆道 ${code} 不在这张派工单里` }
  }
  const executed = executedCodes(order)
  if (executed.includes(code)) {
    return { ok: false, message: `缆道 ${code} 已执行，不能重复确认` }
  }
  const nextExecuted = [...executed, code]
  const allDone = orderCodes(order).every((item) => nextExecuted.includes(item))
  const updated: EntryRow = {
    ...order,
    已执行缆道: nextExecuted.join('、'),
    status: allDone ? FINAL_STATUS : '执行中',
    派工状态: allDone ? FINAL_STATUS : '执行中',
    pending: !allDone,
  }
  const nextOrders = listRows(DISPATCH_KEY).map((row) => (Number(row.id) === id ? updated : row))
  const nextCableways = listRows(CABLEWAY_KEY).map((row) =>
    field(row, '缆道编号') === code
      ? { ...row, status: '正常运行', 缆道状态: '正常运行', 最近检修日: today(), abnormal: false }
      : row,
  )
  try {
    saveRowsBatch({ [DISPATCH_KEY]: nextOrders, [CABLEWAY_KEY]: nextCableways })
  } catch (error) {
    return { ok: false, message: `确认执行失败：${errorMessage(error)}，派工单与缆道状态均未改动` }
  }
  return {
    ok: true,
    message: allDone
      ? `缆道 ${code} 已执行，派工单 ${field(order, '派工单号')} 全部完成，转入已执行`
      : `缆道 ${code} 已执行，剩余 ${orderCodes(order).length - nextExecuted.length} 条待执行`,
  }
}

// 下游两处联动数据：按涉及站点逐站生成站房受托任务和巡检现场确认。
// 先清掉这张工单旧的那一套再写入新的，重复确认只保留一套。
function buildDownstream(order: EntryRow): {
  stationhouse: EntryRow[]
  inspection: EntryRow[]
  addedTasks: number
  addedConfirms: number
} {
  const orderCode = field(order, '派工单号')
  const stations = stationByName()
  const involvedStations = field(order, '涉及站点').split('、').filter((name) => name !== '')
  const stationhouseBase = listRows(STATIONHOUSE_KEY).filter(
    (row) => field(row, '关联派工单') !== orderCode,
  )
  const inspectionBase = listRows(INSPECTION_KEY).filter(
    (row) => field(row, '关联派工单') !== orderCode,
  )
  const stationhouse = [...stationhouseBase]
  const inspection = [...inspectionBase]
  let taskId = nextId(stationhouseBase)
  let confirmId = nextId(inspectionBase)
  for (const stationName of involvedStations) {
    stationhouse.push({
      id: taskId,
      status: '待安排',
      pending: true,
      abnormal: false,
      记录编号: nextCode(stationhouse, '记录编号', 'ENTR'),
      站点编号: stationCodeOf(stationName, stations),
      维护类型: '受托任务',
      维护内容: `汛前缆道检修受托（${orderCode}）：${field(order, '缆道清单')}`,
      维护单位: field(order, '管理单位'),
      维护日期: field(order, '计划检修日'),
      费用支出: 0,
      维护状态: '待安排',
      关联派工单: orderCode,
    })
    taskId += 1
    inspection.push({
      id: confirmId,
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: nextCode(inspection, '记录编号', 'CONF'),
      站点编号: stationCodeOf(stationName, stations),
      巡检日期: field(order, '计划检修日'),
      巡检人员: field(order, '值班员'),
      检查项目: '现场确认',
      发现问题: '待现场确认',
      处理措施: '—',
      巡检状态: '待巡检',
      关联派工单: orderCode,
    })
    confirmId += 1
  }
  return {
    stationhouse,
    inspection,
    addedTasks: stationhouse.length - stationhouseBase.length,
    addedConfirms: inspection.length - inspectionBase.length,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '本地存储写入失败'
}
