const { load, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
const DEFAULT_PENDING_DAYS = 14;
const DEFAULT_STALE_DAYS = 30;
const MAX_DAYS = 3650;

// 清单条数上限：留空用默认值，填了就必须是 1 到 100 的整数；清单取不满时按实际条数返回，不算错
function readLimit(value) {
  const text = pickText(value);
  if (!text) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(text)) {
    throw new ApiError(400, 'SUMMARY_LIMIT_INVALID', '清单条数上限要是正整数', 'summaryLimit');
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, 'SUMMARY_LIMIT_INVALID', `清单条数上限要在 1 到 ${MAX_LIMIT} 之间`, 'summaryLimit');
  }
  return limit;
}

// 天数门槛：留空用默认值，填了就必须是不超过上限的非负整数
function readDays(value, fallback, field) {
  const text = pickText(value);
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) {
    throw new ApiError(400, 'SUMMARY_DAYS_INVALID', '天数门槛要是非负整数', field);
  }
  const days = Number(text);
  if (days > MAX_DAYS) {
    throw new ApiError(400, 'SUMMARY_DAYS_INVALID', `天数门槛不能超过 ${MAX_DAYS} 天`, field);
  }
  return days;
}

// 占比统一口径：分母永远是当前登记的总条数，保留一位小数；一条都没有时占比记零
function percentOf(count, total) {
  if (!total) return 0;
  return Math.round((count * 1000) / total) / 10;
}

// 距离最近一次改动过了多少天，时间读不出来时按零天算
function daysSince(isoText, now) {
  const time = Date.parse(isoText);
  if (Number.isNaN(time)) return 0;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

// 台账总览：按项目与按状态的条数与占比，外加几类需要盯住的清单
function getSummary(options) {
  const input = options && typeof options === 'object' ? options : {};
  const limit = readLimit(input.limit);
  const pendingDays = readDays(input.pendingDays, DEFAULT_PENDING_DAYS, 'summaryPendingDays');
  const staleDays = readDays(input.staleDays, DEFAULT_STALE_DAYS, 'summaryStaleDays');

  const data = load();
  const now = Date.now();
  const total = data.deps.length;

  const projectNames = {};
  data.projects.forEach((item) => { projectNames[item.id] = item.name; });

  const countByProject = {};
  const countByStatus = {};
  data.deps.forEach((item) => {
    countByProject[item.projectId] = (countByProject[item.projectId] || 0) + 1;
    countByStatus[item.status] = (countByStatus[item.status] || 0) + 1;
  });

  // 每个项目、每种状态都列出来，哪怕一条没有，几个项目与几种状态之间才能横着比
  const byProject = data.projects
    .map((item) => {
      const count = countByProject[item.id] || 0;
      return { projectId: item.id, projectName: item.name, count, percent: percentOf(count, total) };
    })
    .sort((a, b) => (b.count - a.count) || (a.projectName < b.projectName ? -1 : 1));

  const byStatus = STATUSES.map((status) => {
    const count = countByStatus[status] || 0;
    return { status, count, percent: percentOf(count, total) };
  });

  // 清单里的每一条都带上所属项目与距离最近一次改动的天数
  const toItem = (item) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    projectId: item.projectId,
    projectName: projectNames[item.projectId] || item.projectId,
    status: item.status,
    days: daysSince(item.updatedAt, now),
    updatedAt: item.updatedAt,
  });

  const byDaysDesc = (a, b) => (b.days - a.days) || (a.name < b.name ? -1 : 1);

  const missingLicense = data.deps.filter((item) => !item.license).map(toItem).sort(byDaysDesc);
  const missingOwner = data.deps.filter((item) => !item.owner).map(toItem).sort(byDaysDesc);
  const pendingStale = data.deps
    .filter((item) => item.status === '待升' && daysSince(item.updatedAt, now) > pendingDays)
    .map(toItem)
    .sort(byDaysDesc);
  const staleUpdated = data.deps
    .filter((item) => daysSince(item.updatedAt, now) > staleDays)
    .map(toItem)
    .sort(byDaysDesc);

  // 同一个依赖名只在单个项目里出现过的，按依赖名归并后挑出来，比较时忽略大小写
  const projectsByName = {};
  data.deps.forEach((item) => {
    const key = item.name.toLowerCase();
    if (!projectsByName[key]) projectsByName[key] = { item, projectIds: new Set() };
    projectsByName[key].projectIds.add(item.projectId);
  });
  const singleProject = Object.keys(projectsByName)
    .filter((key) => projectsByName[key].projectIds.size === 1)
    .map((key) => toItem(projectsByName[key].item))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  // 每类清单都按上限截断，取不满就按实际条数返回，不因为不够数而报错
  const cap = (list) => ({ total: list.length, items: list.slice(0, limit) });

  return {
    generatedAt: new Date(now).toISOString(),
    total,
    params: { limit, pendingDays, staleDays },
    byProject,
    byStatus,
    watch: {
      missingLicense: cap(missingLicense),
      missingOwner: cap(missingOwner),
      pendingStale: { days: pendingDays, ...cap(pendingStale) },
      singleProject: cap(singleProject),
      staleUpdated: { days: staleDays, ...cap(staleUpdated) },
    },
  };
}

module.exports = { getSummary };
