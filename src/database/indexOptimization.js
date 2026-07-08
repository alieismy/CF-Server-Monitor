import { saveSiteOptions, debug, getSettingByKey } from '../utils/settings.js';
import { getAllServers, clearServersListCache } from '../utils/cache.js';

export const HISTORY_PARTITION_MULTIPLIER = 10000000000000;
export const HISTORY_AUTO_OPTIMIZED_MIN_ID = HISTORY_PARTITION_MULTIPLIER;
export const HISTORY_MAX_PARTITION_ID = 900;

// 确保servers历史记录分区优化
export async function ensureServerOptimization(db) {
  // 检查是否已优化
  if (await getSettingByKey(db, 'servers_optimized', true)) {
    debug('服务器历史记录分区已优化');
    return;
  }

  // 批量添加字段
  await db.exec(`
    ALTER TABLE servers ADD COLUMN history_partition_id INTEGER DEFAULT 0;
    ALTER TABLE servers ADD COLUMN timestamp INTEGER DEFAULT 0;
  `);

  // 复用 getAllServers 获取所有服务器
  const servers = await getAllServers(db, true); // includeHidden = true
  
  if (servers.length === 0) {
    debug('没有服务器需要优化');
    await saveSiteOptions(db, { servers_optimized: '1' });
    return { success: true, assigned: 0 };
  }

  // 分配 partition_id
  const usedIds = new Set();
  const updates = [];
  const cacheMap = new Map();

  for (const server of servers) {
    let partitionId = normalizeHistoryPartitionId(server.history_partition_id);
    
    if (partitionId && !usedIds.has(partitionId)) {
      usedIds.add(partitionId);
    } else {
      partitionId = nextAvailableHistoryPartitionId(usedIds);
      usedIds.add(partitionId);
      updates.push({ id: server.id, partitionId });
    }
    
    cacheMap.set(server.id, partitionId);
  }

  // 批量更新数据库
  if (updates.length > 0) {
    // 使用 CASE WHEN 一次性更新
    const caseStatements = updates
      .map(({ id, partitionId }) => `WHEN ${id} THEN ${partitionId}`)
      .join(' ');
    
    const ids = updates.map(({ id }) => id).join(',');
    
    await db.exec(`
      UPDATE servers 
      SET history_partition_id = CASE id 
        ${caseStatements}
      END
      WHERE id IN (${ids})
    `);
  }

  // 清空服务器列表的缓存
  clearServersListCache();

  debug(`服务器历史记录分区优化完成，更新了 ${updates.length} 条记录`);
  
  // 标记为已优化
  await saveSiteOptions(db, { servers_optimized: '1' });

  return { success: true, assigned: updates.length };
}

// 获取下一个可用的历史记录分区ID
export async function getNextServerHistoryPartitionId(db) {
  const servers = await getAllServers(db, true);
  const usedIds = new Set(
    servers
      .map(s => Number(s.history_partition_id))
      .filter(id => Number.isInteger(id) && id > 0 && id <= HISTORY_MAX_PARTITION_ID)
  );
  
  for (let id = 1; id <= HISTORY_MAX_PARTITION_ID; id++) {
    if (!usedIds.has(id)) return id;
  }
  debug(`No available history partition id`);
  throw new Error(`No available history partition id`);
}

// 格式化历史记录时间戳
export function normalizeHistoryTimestamp(value, fallback = Date.now()) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return fallback;
  return ts < 10000000000 ? ts * 1000 : ts;
}

export function formatHistoryTimeKey(timestamp) {
  const normalized = normalizeHistoryTimestamp(timestamp);

  const date = new Date(normalized);
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2099) {
    debug(`Invalid year ${year} for history time key`);
    throw new Error(`Invalid year ${year} for history time key`);
  };

  return Number([
    padHistoryTimePart(year % 100),
    padHistoryTimePart(date.getUTCMonth() + 1),
    padHistoryTimePart(date.getUTCDate()),
    padHistoryTimePart(date.getUTCHours()),
    padHistoryTimePart(date.getUTCMinutes()),
    padHistoryTimePart(date.getUTCSeconds())
  ].join(''));
}

export function normalizeHistoryPartitionId(value) {
  const partitionId = Number(value);
  if (!Number.isInteger(partitionId) || partitionId <= 0 || partitionId > HISTORY_MAX_PARTITION_ID) {
    return null;
  }
  return partitionId;
}

export function buildHistoryId(partitionId, timestamp) {
  const normalizedPartitionId = normalizeHistoryPartitionId(partitionId);
  if (!normalizedPartitionId) {
    throw new Error('Invalid history partition id');
  }
  return normalizedPartitionId * 10000000000000 + formatHistoryTimeKey(timestamp);
}