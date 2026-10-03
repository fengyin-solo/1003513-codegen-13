<template>
  <section class="page" data-module="dispatch">
    <header class="page-head">
      <div>
        <h2>检修派工单（汛前检查）</h2>
        <p class="page-desc">从待检修测流缆道中按所属站点、缆道编号批量勾选，整组生成一张派工单；同组只能选择同一管理单位。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出派工单清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">候选缆道数</span>
        <strong class="stat-value">{{ candidates.length }}</strong>
      </article>
      <article v-for="item in statusSummary" :key="item.status" class="stat-card">
        <span class="stat-label">{{ item.status }}工单</span>
        <strong class="stat-value">{{ item.count }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3>待检修缆道候选</h3>
      <p class="panel-desc">
        跨度米数与荷载能力分别列出；没有最近检修日的老缆道一并纳入候选，标注「无检修记录」，汛前检查不留死角。
      </p>
      <form class="filter-bar" @submit.prevent>
        <label class="filter-item">
          <span>所属站点</span>
          <input v-model="stationFilter" placeholder="按所属站点检索" />
        </label>
        <label class="filter-item">
          <span>缆道编号</span>
          <input v-model="codeFilter" placeholder="按缆道编号检索" />
        </label>
      </form>
      <table class="data-table">
        <thead>
          <tr>
            <th>勾选</th>
            <th>缆道编号</th>
            <th>所属站点</th>
            <th>管理单位</th>
            <th>跨度米数</th>
            <th>荷载能力</th>
            <th>最近检修日</th>
            <th>入选原因</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in candidateGroups" :key="group.unit">
            <tr class="group-row">
              <td>
                <input
                  type="checkbox"
                  :checked="isGroupChecked(group.items)"
                  @change="toggleGroup(group.items)"
                />
              </td>
              <td colspan="7">{{ group.unit }}（{{ group.items.length }} 条待检修）</td>
            </tr>
            <tr v-for="item in group.items" :key="item.id">
              <td><input v-model="selectedIds" type="checkbox" :value="item.id" /></td>
              <td>{{ item.缆道编号 }}</td>
              <td>{{ item.所属站点 }}</td>
              <td>{{ item.管理单位 }}</td>
              <td>{{ item.跨度米数 }}</td>
              <td>{{ item.荷载能力 }}</td>
              <td>{{ item.最近检修日 || '—' }}</td>
              <td>{{ item.入选原因 }}</td>
            </tr>
          </template>
          <tr v-if="!candidateGroups.length">
            <td colspan="8" class="empty-state">当前没有待检修的缆道候选</td>
          </tr>
        </tbody>
      </table>
      <footer class="panel-foot">
        <span v-if="selectionConflict" class="error-text">
          已勾选 {{ selectedIds.length }} 条，涉及多个管理单位（{{ selectedUnits.join('、') }}），同组只能选择同一管理单位
        </span>
        <span v-else>
          已勾选 {{ selectedIds.length }} 条
          <template v-if="selectedUnits.length === 1"> · 管理单位：{{ selectedUnits[0] }}</template>
        </span>
        <button class="btn primary" type="button" @click="generateOrder">生成派工单（整组一张）</button>
      </footer>
    </section>

    <section class="panel">
      <h3>派工单列表</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>派工单号</th>
            <th>管理单位</th>
            <th>涉及站点</th>
            <th>缆道数量</th>
            <th>计划检修日</th>
            <th>值班员</th>
            <th>审核人</th>
            <th>当前状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="order in orders" :key="String(order.id)">
            <tr>
              <td>
                <button class="link" type="button" @click="toggleDetail(order)">
                  {{ order.派工单号 }}
                </button>
              </td>
              <td>{{ order.管理单位 }}</td>
              <td>{{ order.涉及站点 }}</td>
              <td>{{ order.缆道数量 }}</td>
              <td>{{ order.计划检修日 }}</td>
              <td>{{ order.值班员 }}</td>
              <td>{{ order.审核人 || '—' }}</td>
              <td>{{ order.status }}</td>
              <td class="row-actions">
                <button
                  v-if="order.status === '待审核'"
                  class="link"
                  type="button"
                  @click="submitOrder(order)"
                >
                  审核通过并提交
                </button>
                <button
                  v-if="order.status === '已审核'"
                  class="link"
                  type="button"
                  @click="startOrder(order)"
                >
                  开始执行
                </button>
                <button
                  v-if="order.status !== '已执行'"
                  class="link"
                  type="button"
                  @click="toggleDetail(order)"
                >
                  调整
                </button>
                <span v-if="order.status === '已执行'" class="muted-text">已执行，不可回退</span>
              </td>
            </tr>
            <tr v-if="expandedId === Number(order.id)" class="detail-row">
              <td colspan="9">
                <div class="detail-block">
                  <h4>缆道明细（已执行项目锁定，不能回退）</h4>
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>缆道编号</th>
                        <th>所属站点</th>
                        <th>跨度米数</th>
                        <th>荷载能力</th>
                        <th>执行状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in orderItems(order)" :key="item.code">
                        <td>{{ item.code }}</td>
                        <td>{{ item.station }}</td>
                        <td>{{ item.span }}</td>
                        <td>{{ item.load }}</td>
                        <td>{{ item.executed ? '已执行' : '待执行' }}</td>
                        <td class="row-actions">
                          <button
                            v-if="order.status === '执行中' && !item.executed"
                            class="link"
                            type="button"
                            @click="executeItem(order, item.code)"
                          >
                            确认执行
                          </button>
                          <button
                            v-if="order.status !== '已执行' && !item.executed"
                            class="link"
                            type="button"
                            @click="removeItem(order, item.code)"
                          >
                            移出
                          </button>
                          <span v-if="item.executed" class="muted-text">已执行，不能回退</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <form
                    v-if="order.status !== '已执行'"
                    class="filter-bar adjust-bar"
                    @submit.prevent="saveAdjust(order)"
                  >
                    <label class="filter-item">
                      <span>计划检修日</span>
                      <input v-model="adjustDates[Number(order.id)]" type="date" />
                    </label>
                    <label class="filter-item">
                      <span>审核人</span>
                      <input v-model="adjustReviewers[Number(order.id)]" placeholder="审核人" />
                    </label>
                    <button class="btn" type="submit">保存调整</button>
                  </form>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!orders.length">
            <td colspan="9" class="empty-state">暂无派工单，先从候选缆道勾选生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ orders.length }} 张派工单</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  adjustDispatchOrder,
  createDispatchOrder,
  executeDispatchItem,
  listCandidates,
  listDispatchOrders,
  startDispatchOrder,
  submitDispatchOrder,
  type DispatchCandidate,
} from '@/api/dispatch-service'
import { downloadEntries } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const statuses = ['待审核', '已审核', '执行中', '已执行']

const candidates = ref<DispatchCandidate[]>([])
const orders = ref<EntryRow[]>([])
const selectedIds = ref<number[]>([])
const stationFilter = ref('')
const codeFilter = ref('')
const expandedId = ref<number | null>(null)
const adjustDates = ref<Record<number, string>>({})
const adjustReviewers = ref<Record<number, string>>({})
const errorMessage = ref('')
const successMessage = ref('')

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: orders.value.filter((row) => String(row.status) === status).length,
  })),
)

const filteredCandidates = computed(() =>
  candidates.value.filter(
    (item) =>
      item.所属站点.includes(stationFilter.value.trim()) &&
      item.缆道编号.includes(codeFilter.value.trim()),
  ),
)

// 候选按管理单位分组展示，方便值班员按「同组同一管理单位」的规则整组勾选。
const candidateGroups = computed(() => {
  const groups = new Map<string, DispatchCandidate[]>()
  for (const item of filteredCandidates.value) {
    const list = groups.get(item.管理单位) ?? []
    list.push(item)
    groups.set(item.管理单位, list)
  }
  return [...groups.entries()].map(([unit, items]) => ({ unit, items }))
})

const selectedUnits = computed(() => {
  const units = candidates.value
    .filter((item) => selectedIds.value.includes(item.id))
    .map((item) => item.管理单位)
  return [...new Set(units)]
})

const selectionConflict = computed(() => selectedUnits.value.length > 1)

function isGroupChecked(items: DispatchCandidate[]): boolean {
  return items.length > 0 && items.every((item) => selectedIds.value.includes(item.id))
}

function toggleGroup(items: DispatchCandidate[]) {
  const ids = items.map((item) => item.id)
  if (isGroupChecked(items)) {
    selectedIds.value = selectedIds.value.filter((id) => !ids.includes(id))
  } else {
    selectedIds.value = [...new Set([...selectedIds.value, ...ids])]
  }
}

function toggleDetail(order: EntryRow) {
  const id = Number(order.id)
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  adjustDates.value[id] = String(order.计划检修日 ?? '')
  adjustReviewers.value[id] = String(order.审核人 ?? '') || store.operator
}

// 明细行：把派工单里的缆道编号翻译回缆道档案，跨度米数、荷载能力分别展示。
function orderItems(order: EntryRow) {
  const cableways = listRows('cableway')
  const executed = String(order.已执行缆道 ?? '').split('、').filter(Boolean)
  return String(order.缆道清单 ?? '')
    .split('、')
    .filter(Boolean)
    .map((code) => {
      const cableway = cableways.find((row) => String(row.缆道编号) === code)
      return {
        code,
        station: cableway ? String(cableway.所属站点) : '—',
        span: cableway ? String(cableway.跨度米数) : '—',
        load: cableway ? String(cableway.荷载能力) : '—',
        executed: executed.includes(code),
      }
    })
}

function apply(result: ActionResult) {
  if (result.ok) {
    successMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    successMessage.value = ''
  }
  reload()
}

function generateOrder() {
  apply(createDispatchOrder([...selectedIds.value], store.operator))
  if (!errorMessage.value) {
    selectedIds.value = []
  }
}

function submitOrder(order: EntryRow) {
  apply(submitDispatchOrder(Number(order.id), store.operator))
}

function startOrder(order: EntryRow) {
  apply(startDispatchOrder(Number(order.id)))
}

function executeItem(order: EntryRow, code: string) {
  apply(executeDispatchItem(Number(order.id), code))
}

function removeItem(order: EntryRow, code: string) {
  apply(adjustDispatchOrder(Number(order.id), { removeCodes: [code] }))
}

function saveAdjust(order: EntryRow) {
  const id = Number(order.id)
  apply(
    adjustDispatchOrder(id, {
      计划检修日: adjustDates.value[id],
      审核人: adjustReviewers.value[id],
    }),
  )
}

function exportRows() {
  downloadEntries('dispatch')
}

function reload() {
  candidates.value = listCandidates()
  orders.value = listDispatchOrders()
}

onMounted(reload)
</script>
