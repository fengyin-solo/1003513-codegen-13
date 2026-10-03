<template>
  <section class="page" data-module="dispatch">
    <header class="page-head">
      <div>
        <h2>汛前检查派工</h2>
        <p class="page-desc">
          从待检修缆道批量勾选，整组生成一张检修派工单；审核派工时同步生成站房受托任务与巡检现场确认，任一写入失败三处全部回退。
        </p>
      </div>
      <div class="page-actions">
        <label class="filter-item">
          <span>值班员</span>
          <input v-model="operator" />
        </label>
        <label class="filter-item">
          <span>审核人</span>
          <input v-model="reviewer" />
        </label>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <h3 class="section-title">待检修缆道候选</h3>
    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>所属站点</span>
        <input v-model="filters.所属站点" placeholder="按所属站点检索" />
      </label>
      <label class="filter-item">
        <span>缆道编号</span>
        <input v-model="filters.缆道编号" placeholder="按缆道编号检索" />
      </label>
      <span class="filter-hint">同组只能选择同一管理单位；无最近检修日的老缆道一并纳入候选</span>
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
          <th>候选原因</th>
          <th>占用情况</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="candidate in filteredCandidates" :key="String(candidate.row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selected.has(Number(candidate.row.id))"
              :disabled="candidate.lockedBy !== ''"
              @change="toggle(candidate)"
            />
          </td>
          <td>{{ candidate.row['缆道编号'] }}</td>
          <td>{{ candidate.row['所属站点'] }}</td>
          <td>{{ candidate.row['管理单位'] }}</td>
          <td>{{ candidate.row['跨度米数'] }}</td>
          <td>{{ candidate.row['荷载能力'] }}</td>
          <td>{{ candidate.row['最近检修日'] || '—' }}</td>
          <td><span class="legend-item">{{ candidate.reason }}</span></td>
          <td>{{ candidate.lockedBy ? `已在 ${candidate.lockedBy}` : '可勾选' }}</td>
        </tr>
        <tr v-if="!filteredCandidates.length">
          <td colspan="9" class="empty-state">当前没有待检修候选缆道</td>
        </tr>
      </tbody>
    </table>

    <form class="filter-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>受托单位</span>
        <input v-model="createForm.受托单位" placeholder="承担检修的单位" />
      </label>
      <label class="filter-item">
        <span>巡检人员</span>
        <input v-model="createForm.巡检人员" placeholder="现场确认人" />
      </label>
      <label class="filter-item">
        <span>计划检修日期</span>
        <input v-model="createForm.计划检修日期" type="date" />
      </label>
      <button class="btn primary" type="submit">整组生成派工单（已选 {{ selected.size }} 条）</button>
    </form>

    <h3 class="section-title">检修派工单</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>派工单号</th>
          <th>管理单位</th>
          <th>受托单位</th>
          <th>计划检修日期</th>
          <th>缆道数量</th>
          <th>创建人</th>
          <th>审核人</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="order in orders" :key="String(order.row.id)">
          <tr>
            <td>{{ order.row['派工单号'] }}</td>
            <td>{{ order.row['管理单位'] }}</td>
            <td>{{ order.row['受托单位'] }}</td>
            <td>{{ order.row['计划检修日期'] }}</td>
            <td>{{ order.row['缆道数量'] }}</td>
            <td>{{ order.row['创建人'] }}</td>
            <td>{{ order.row['审核人'] || '—' }}</td>
            <td>{{ order.row.status }}</td>
            <td class="row-actions">
              <button v-if="order.row.status === '待审核'" class="link" type="button" @click="openAdjust(order)">
                调整
              </button>
              <button v-if="order.row.status === '待审核'" class="link" type="button" @click="confirm(order)">
                审核派工
              </button>
              <button v-if="order.row.status === '已派工'" class="link" type="button" @click="withdraw(order)">
                退回调整
              </button>
              <button v-if="order.row.status === '已派工'" class="link" type="button" @click="start(order)">
                开始执行
              </button>
              <button v-if="order.row.status === '执行中'" class="link" type="button" @click="complete(order)">
                完成执行
              </button>
              <span v-if="order.row.status === '已完成'">已办结</span>
            </td>
          </tr>
          <tr>
            <td colspan="9" class="item-cell">
              缆道明细：
              <span v-for="item in order.items" :key="item.id" class="legend-item">
                {{ item.缆道编号 }}（{{ item.所属站点 }} · 跨度{{ item.跨度米数 }}米 · 荷载{{ item.荷载能力 }}）
              </span>
            </td>
          </tr>
        </template>
        <tr v-if="!orders.length">
          <td colspan="9" class="empty-state">还没有派工单，先从上方候选缆道勾选生成</td>
        </tr>
      </tbody>
    </table>

    <div v-if="adjusting" class="adjust-panel">
      <h3 class="section-title">调整派工单 {{ adjusting.row['派工单号'] }}（仅待审核可调整，已执行项目不能回退）</h3>
      <form class="filter-bar" @submit.prevent="saveAdjust">
        <label class="filter-item">
          <span>受托单位</span>
          <input v-model="adjustForm.受托单位" />
        </label>
        <label class="filter-item">
          <span>巡检人员</span>
          <input v-model="adjustForm.巡检人员" />
        </label>
        <label class="filter-item">
          <span>计划检修日期</span>
          <input v-model="adjustForm.计划检修日期" type="date" />
        </label>
        <button class="btn primary" type="submit">保存调整</button>
        <button class="btn ghost" type="button" @click="adjusting = null">取消</button>
      </form>
      <table class="data-table">
        <thead>
          <tr>
            <th>缆道编号</th>
            <th>所属站点</th>
            <th>跨度米数</th>
            <th>荷载能力</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in adjustItems" :key="item.id">
            <td>{{ item.缆道编号 }}</td>
            <td>{{ item.所属站点 }}</td>
            <td>{{ item.跨度米数 }}</td>
            <td>{{ item.荷载能力 }}</td>
            <td><button class="link" type="button" @click="removeAdjustItem(item.id)">移出</button></td>
          </tr>
        </tbody>
      </table>
      <form class="filter-bar" @submit.prevent="addAdjustItem">
        <label class="filter-item">
          <span>补选同单位候选缆道</span>
          <select v-model="adjustAddId">
            <option value="">请选择</option>
            <option v-for="candidate in addableCandidates" :key="String(candidate.row.id)" :value="String(candidate.row.id)">
              {{ candidate.row['缆道编号'] }}（{{ candidate.row['所属站点'] }}）
            </option>
          </select>
        </label>
        <button class="btn" type="submit">加入派工单</button>
      </form>
    </div>

    <footer class="page-foot">
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  adjustDispatch,
  completeExecution,
  confirmDispatch,
  createDispatch,
  listCandidates,
  listDispatches,
  startExecution,
  toDispatchItem,
  withdrawDispatch,
} from '@/api/dispatch-service'
import type { Candidate, DispatchItem, DispatchView } from '@/api/dispatch-service'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const operator = ref(store.operator)
const reviewer = ref('审核员')

const candidates = ref<Candidate[]>([])
const orders = ref<DispatchView[]>([])
const selected = ref<Set<number>>(new Set())
const filters = reactive({ 所属站点: '', 缆道编号: '' })
const createForm = reactive({ 受托单位: '', 巡检人员: '', 计划检修日期: '' })
const okMessage = ref('')
const errorMessage = ref('')

const adjusting = ref<DispatchView | null>(null)
const adjustForm = reactive({ 受托单位: '', 巡检人员: '', 计划检修日期: '' })
const adjustItems = ref<DispatchItem[]>([])
const adjustAddId = ref('')

const stats = computed(() => [
  { label: '候选缆道', value: candidates.value.length },
  { label: '待审核工单', value: orders.value.filter((order) => order.row.status === '待审核').length },
  { label: '已派工工单', value: orders.value.filter((order) => order.row.status === '已派工').length },
  { label: '执行中工单', value: orders.value.filter((order) => order.row.status === '执行中').length },
])

const filteredCandidates = computed(() =>
  candidates.value.filter(
    (candidate) =>
      String(candidate.row['所属站点'] ?? '').includes(filters.所属站点.trim()) &&
      String(candidate.row['缆道编号'] ?? '').includes(filters.缆道编号.trim()),
  ),
)

const selectedUnit = computed(() => {
  for (const candidate of candidates.value) {
    if (selected.value.has(Number(candidate.row.id))) {
      return String(candidate.row['管理单位'] ?? '') || '未登记'
    }
  }
  return ''
})

const addableCandidates = computed(() => {
  if (!adjusting.value) {
    return []
  }
  const unit = String(adjusting.value.row['管理单位'])
  const inOrder = new Set(adjustItems.value.map((item) => item.id))
  return candidates.value.filter(
    (candidate) =>
      candidate.lockedBy === '' &&
      !inOrder.has(Number(candidate.row.id)) &&
      (String(candidate.row['管理单位'] ?? '') || '未登记') === unit,
  )
})

function clearMessages() {
  okMessage.value = ''
  errorMessage.value = ''
}

function toggle(candidate: Candidate) {
  clearMessages()
  const id = Number(candidate.row.id)
  if (selected.value.has(id)) {
    selected.value.delete(id)
    return
  }
  const unit = String(candidate.row['管理单位'] ?? '') || '未登记'
  if (selectedUnit.value && selectedUnit.value !== unit) {
    errorMessage.value = `同组派工只能选择同一管理单位：已选 ${selectedUnit.value}，${candidate.row['缆道编号']} 属于 ${unit}`
    return
  }
  selected.value.add(id)
}

function submitCreate() {
  clearMessages()
  const result = createDispatch({
    cablewayIds: [...selected.value],
    受托单位: createForm.受托单位,
    巡检人员: createForm.巡检人员,
    计划检修日期: createForm.计划检修日期,
    创建人: operator.value,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  selected.value = new Set()
  createForm.受托单位 = ''
  createForm.巡检人员 = ''
  createForm.计划检修日期 = ''
  reload()
}

function confirm(order: DispatchView) {
  clearMessages()
  const result = confirmDispatch(Number(order.row.id), reviewer.value)
  show(result.ok, result.message)
}

function withdraw(order: DispatchView) {
  clearMessages()
  const result = withdrawDispatch(Number(order.row.id))
  show(result.ok, result.message)
}

function start(order: DispatchView) {
  clearMessages()
  const result = startExecution(Number(order.row.id))
  show(result.ok, result.message)
}

function complete(order: DispatchView) {
  clearMessages()
  const result = completeExecution(Number(order.row.id))
  show(result.ok, result.message)
}

function openAdjust(order: DispatchView) {
  clearMessages()
  adjusting.value = order
  adjustForm.受托单位 = String(order.row['受托单位'])
  adjustForm.巡检人员 = String(order.row['巡检人员'])
  adjustForm.计划检修日期 = String(order.row['计划检修日期'])
  adjustItems.value = [...order.items]
  adjustAddId.value = ''
}

function removeAdjustItem(id: number) {
  adjustItems.value = adjustItems.value.filter((item) => item.id !== id)
}

function addAdjustItem() {
  clearMessages()
  if (!adjustAddId.value) {
    return
  }
  const candidate = candidates.value.find((item) => String(item.row.id) === adjustAddId.value)
  if (!candidate) {
    errorMessage.value = '这条缆道已不在候选范围'
    return
  }
  adjustItems.value = [...adjustItems.value, toDispatchItem(candidate.row)]
  adjustAddId.value = ''
}

function saveAdjust() {
  clearMessages()
  if (!adjusting.value) {
    return
  }
  const originalIds = new Set(adjusting.value.items.map((item) => item.id))
  const currentIds = new Set(adjustItems.value.map((item) => item.id))
  const result = adjustDispatch(Number(adjusting.value.row.id), {
    受托单位: adjustForm.受托单位,
    巡检人员: adjustForm.巡检人员,
    计划检修日期: adjustForm.计划检修日期,
    addCablewayIds: [...currentIds].filter((id) => !originalIds.has(id)),
    removeCablewayIds: [...originalIds].filter((id) => !currentIds.has(id)),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  adjusting.value = null
  reload()
}

function show(ok: boolean, message: string) {
  if (ok) {
    okMessage.value = message
  } else {
    errorMessage.value = message
  }
  reload()
}

function reload() {
  candidates.value = listCandidates()
  orders.value = listDispatches()
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  margin: 16px 0 8px;
  font-size: 14px;
}
.filter-hint {
  align-self: center;
  color: var(--muted);
  font-size: 12px;
}
.item-cell {
  color: var(--muted);
  font-size: 12px;
}
.adjust-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-top: 12px;
}
.ok-text {
  color: #067647;
}
</style>
