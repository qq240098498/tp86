// 台账总览：一次性给出按项目、按状态的条数与占比，以及几类需要盯住的登记清单。
// 所有占比的分母统一是当前登记的总条数，取整一律四舍五入，几个分组之间可以横着比。
const { load, STATUSES } = require('./store');
const { pickText } = require('./errors');

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
// 停在待升超过多少天算拖太久；最近改动超过多少天算很久没动
const STALE_PENDING_DAYS = 14;
const STALE_UPDATED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// 清单里每条只带页面用得到的字段，并附上所属项目名，省得页面再拼一次
function toListItem(dep, projectName, extra) {
  return {
    id: dep.id,
    projectId: dep.projectId,
    projectName,
    name: dep.name,
    version: dep.version,
    license: dep.license,
    owner: dep.owner,
    status: dep.status,
    updatedAt: dep.updatedAt,
    ...extra,
  };
}

// 占比统一按 total 当分母四舍五入；没有任何登记时记 0，避免出现 NaN
function percentOf(count, total) {
  return total === 0 ? 0 : Math.round((count * 100) / total);
}

// 上限由页面指定：留空或写法不成立时回落默认值，超过最大值就收到最大值，不因此报错
function readLimit(value) {
  const text = pickText(value);
  if (!/^\d+$/.test(text)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(text, 10);
  if (parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function daysBetween(fromIso, nowMs) {
  const time = Date.parse(fromIso);
  if (Number.isNaN(time)) return 0;
  return Math.floor((nowMs - time) / DAY_MS);
}

// 同一个依赖（忽略大小写）只在一个项目里登记过，就进这张清单
function findSingleProjectDeps(deps, projectNames) {
  const groups = new Map();
  deps.forEach((dep) => {
    const key = dep.name.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) {
      bucket.projects.add(dep.projectId);
    } else {
      groups.set(key, { name: dep.name, projects: new Set([dep.projectId]), dep });
    }
  });
  return Array.from(groups.values())
    .filter((bucket) => bucket.projects.size === 1)
    .map((bucket) => toListItem(bucket.dep, projectNames[bucket.dep.projectId] || ''))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function buildOverview(options) {
  const input = options && typeof options === 'object' ? options : {};
  const limit = readLimit(input.limit);
  const data = load();
  const deps = data.deps;
  const total = deps.length;
  const nowMs = Date.now();

  const projectNames = {};
  data.projects.forEach((project) => { projectNames[project.id] = project.name; });

  // 按项目：每个项目都出现，哪怕一条登记都没有
  const projectCounts = new Map(data.projects.map((project) => [project.id, 0]));
  deps.forEach((dep) => {
    if (projectCounts.has(dep.projectId)) {
      projectCounts.set(dep.projectId, projectCounts.get(dep.projectId) + 1);
    }
  });
  const byProject = data.projects
    .map((project) => {
      const count = projectCounts.get(project.id) || 0;
      return { id: project.id, name: project.name, count, percent: percentOf(count, total) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // 按状态：三种状态固定顺序都列出来，条数为 0 也保留，横向比较时口径一致
  const statusCounts = new Map(STATUSES.map((status) => [status, 0]));
  deps.forEach((dep) => {
    if (statusCounts.has(dep.status)) statusCounts.set(dep.status, statusCounts.get(dep.status) + 1);
  });
  const byStatus = STATUSES.map((status) => {
    const count = statusCounts.get(status) || 0;
    return { status, count, percent: percentOf(count, total) };
  });

  const nameOf = (dep) => projectNames[dep.projectId] || '';
  const sortByProjectName = (a, b) => {
    if (a.projectName !== b.projectName) return a.projectName < b.projectName ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };

  const missingLicense = deps
    .filter((dep) => !dep.license)
    .map((dep) => toListItem(dep, nameOf(dep)))
    .sort(sortByProjectName);

  const missingOwner = deps
    .filter((dep) => !dep.owner)
    .map((dep) => toListItem(dep, nameOf(dep)))
    .sort(sortByProjectName);

  // 待升拖太久按停更天数从多到少排，最该先处理的在最前面
  const stalePending = deps
    .filter((dep) => dep.status === '待升')
    .map((dep) => toListItem(dep, nameOf(dep), { pendingDays: daysBetween(dep.updatedAt, nowMs) }))
    .filter((item) => item.pendingDays > STALE_PENDING_DAYS)
    .sort((a, b) => b.pendingDays - a.pendingDays || a.updatedAt.localeCompare(b.updatedAt));

  const singleProject = findSingleProjectDeps(deps, projectNames);

  // 很久没动按最近一次改动时间从旧到新排
  const staleUpdated = deps
    .map((dep) => toListItem(dep, nameOf(dep), { staleDays: daysBetween(dep.updatedAt, nowMs) }))
    .filter((item) => item.staleDays > STALE_UPDATED_DAYS)
    .sort((a, b) => b.staleDays - a.staleDays || a.updatedAt.localeCompare(b.updatedAt));

  // 每张清单各自按同一上限截断；取不满时就按实际条数返回，count 仍是命中的总条数
  const lists = {};
  Object.entries({
    missingLicense,
    missingOwner,
    stalePending,
    singleProject,
    staleUpdated,
  }).forEach(([key, items]) => {
    lists[key] = { count: items.length, limit, items: items.slice(0, limit) };
  });

  return {
    total,
    generatedAt: new Date(nowMs).toISOString(),
    limits: { default: DEFAULT_LIMIT, max: MAX_LIMIT },
    thresholds: { pendingDays: STALE_PENDING_DAYS, updatedDays: STALE_UPDATED_DAYS },
    byProject,
    byStatus,
    lists,
  };
}

module.exports = {
  buildOverview,
  readLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STALE_PENDING_DAYS,
  STALE_UPDATED_DAYS,
};
