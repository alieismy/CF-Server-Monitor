<template>
  <div id="tab-database" class="tab-content" :class="{ active: activeTab === 'database' }">
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.dbManagement }}</div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">{{ trans.upgradeDatabase }}</label>
          <p class="text-muted mb-2">{{ trans.upgradeDesc }}</p>
          <button @click="$emit('open-db-modal', 'upgrade')" class="btn btn-primary btn-lg" :disabled="dbLoading">⬆️ {{ trans.upgradeDatabase }}</button>
        </div>

        <div class="form-group">
          <label class="form-label danger-label">⚠️ {{ trans.clearHistory }}</label>
          <p class="text-muted mb-2">{{ trans.clearHistoryDesc }}</p>
          <button @click="$emit('open-db-modal', 'clearHistory')" class="btn btn-red btn-lg" :disabled="dbLoading">🗑️ {{ trans.clearHistory }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'database' },
  dbLoading: { type: Boolean, default: false }
})

defineEmits(['open-db-modal'])
</script>
