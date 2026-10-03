<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">维护站房维护记录，围绕记录编号、站点编号、维护类型、维护内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记站房维护记录</button>
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="panel">
      <h3>受托任务（由检修派工单提交生成）</h3>
      <p class="panel-desc">
        检修派工单审核提交后，按涉及站点逐站生成受托任务；派工单调整会同步重建，重复确认只保留一套。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>站点编号</th>
            <th>维护内容</th>
            <th>维护单位</th>
            <th>维护日期</th>
            <th>关联派工单</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in entrustedTasks" :key="String(task.id)">
            <td>{{ task.记录编号 }}</td>
            <td>{{ task.站点编号 }}</td>
            <td>{{ task.维护内容 }}</td>
            <td>{{ task.维护单位 }}</td>
            <td>{{ task.维护日期 }}</td>
            <td>{{ task.关联派工单 }}</td>
            <td>{{ task.status }}</td>
          </tr>
          <tr v-if="!entrustedTasks.length">
            <td colspan="7" class="empty-state">暂无受托任务，等待检修派工单提交后生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stationhouse')
const columns = ["记录编号", "站点编号", "维护类型", "维护内容", "维护单位", "维护日期", "费用支出", "维护状态"]
const actions = ["安排维护", "确认完工", "通过验收"]
const statuses = ["待安排", "已安排", "施工中", "已完成", "已验收"]
const stats = [{"label": "待维护项数", "value": 0}, {"label": "施工中项数", "value": 0}, {"label": "本月已验收", "value": 0}]

const rows = ref<EntryRow[]>([])
const entrustedTasks = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '站房维护记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 受托任务不受筛选条件影响，始终展示派工单联动生成的完整清单
    entrustedTasks.value = listEntries(meta.key).items.filter(
      (row) => String(row['维护类型']) === '受托任务',
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

onMounted(reload)
</script>
