// 存档与录像的版本化结构 + 老版本迁移
import { CURRENT_CONFIG_VERSION, buildDefaultLevels } from '../data/defaultLevels';
import { clamp } from '../core/interp';
import type { LevelConfig, ScoringConfig, StationConfig, StepAction } from '../core/types';

/** 存档文件结构版本（结构本身变化时 +1，与配置表版本分开） */
export const SAVE_SCHEMA_VERSION = 2;

export interface SaveFile {
  format: 'cascade-dispatch-save';
  schemaVersion: number;
  configVersion: number;
  savedAt: string;
  name: string;
  levelId: string;
  seed: string;
  /** 关卡完整快照：配置表后续改动不影响老存档可读性 */
  level: LevelConfig;
  /** 已执行的操作序列（长度 = currentStep） */
  actions: StepAction[];
  currentStep: number;
  /** 最近一次累计得分（便于存档列表展示） */
  score: number;
  finished: boolean;
}

export interface ReplayFile {
  format: 'cascade-dispatch-replay';
  schemaVersion: number;
  configVersion: number;
  recordedAt: string;
  level: LevelConfig;
  actions: StepAction[];
  resultSnapshot: {
    finalScore: number;
    stars: number;
    steps: number;
    failed: boolean;
  };
}

function defaultScoring(): ScoringConfig {
  return buildDefaultLevels()[0].scoring;
}

/** 深拷贝关卡并补齐缺失字段，使任意历史版本都能读到当前引擎 */
export function migrateLevel(raw: unknown): LevelConfig {
  if (!raw || typeof raw !== 'object') throw new Error('关卡数据格式无效');
  const src = raw as Partial<LevelConfig>;
  const fallback = buildDefaultLevels()[0];
  const oldVersion = typeof src.configVersion === 'number' ? src.configVersion : 1;

  // v1 -> v2：评分项拆细，老存档补默认值
  const scoring: ScoringConfig = { ...defaultScoring(), ...(src.scoring ?? {}) };
  if (oldVersion < 2) {
    scoring.spillPenaltyPerM3 ??= 2e-6;
    scoring.endStorageRewardPerM3 ??= 1e-7;
  }

  const stations: StationConfig[] = (src.stations ?? fallback.stations).map((s) => ({
    ...s,
    spillway: { ...s.spillway },
    plant: { ...s.plant },
    levelStorage: s.levelStorage.map((p) => ({ ...p })),
  }));

  const level: LevelConfig = {
    configVersion: CURRENT_CONFIG_VERSION,
    id: src.id ?? 'custom',
    name: src.name ?? '自定义关卡',
    description: src.description ?? '',
    horizonSteps: clamp(Math.floor(src.horizonSteps ?? 96), 8, 400),
    dtSeconds: src.dtSeconds ?? 21600,
    seed: src.seed ?? 'CUSTOM',
    stations,
    reaches: (src.reaches ?? fallback.reaches).map((r) => ({ ...r })),
    inflow: src.inflow ? structuredClone(src.inflow) : structuredClone(fallback.inflow),
    demand: src.demand ? structuredClone(src.demand) : structuredClone(fallback.demand),
    events: { ...fallback.events, ...(src.events ?? {}) },
    scoring,
  };
  validateLevel(level);
  return level;
}

/** 结构校验：给出可读错误，编辑器导入时用 */
export function validateLevel(level: LevelConfig): void {
  if (level.stations.length < 1) throw new Error('至少需要 1 座电站');
  const ids = new Set<string>();
  for (const s of level.stations) {
    if (ids.has(s.id)) throw new Error(`电站 id 重复: ${s.id}`);
    ids.add(s.id);
    if (s.levelStorage.length < 2) throw new Error(`${s.name} 水位库容曲线至少需要 2 个点`);
    if (!(s.deadLevel < s.normalLevel && s.normalLevel <= s.floodLimitLevel && s.floodLimitLevel < s.damTopLevel)) {
      throw new Error(`${s.name} 水位关系应满足 死水位 < 正常蓄水位 ≤ 汛限 < 坝顶`);
    }
    if (s.plant.unitCount < 1) throw new Error(`${s.name} 机组台数至少为 1`);
  }
  for (const r of level.reaches) {
    if (!ids.has(r.fromStation) || !ids.has(r.toStation)) throw new Error(`河道 ${r.id} 引用了不存在的电站`);
    if (r.routingWeights) {
      const sum = r.routingWeights.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 1e-6) throw new Error(`河道 ${r.id} 槽蓄权重之和必须为 1`);
    }
  }
  if (level.horizonSteps < 8) throw new Error('仿真步数至少 8 步');
}

export function parseSaveFile(raw: unknown): SaveFile {
  if (!raw || typeof raw !== 'object') throw new Error('存档格式无效');
  const f = raw as Partial<SaveFile>;
  if (f.format !== 'cascade-dispatch-save') throw new Error('不是本游戏的存档文件');
  const level = migrateLevel(f.level);
  return {
    format: 'cascade-dispatch-save',
    schemaVersion: SAVE_SCHEMA_VERSION,
    configVersion: level.configVersion,
    savedAt: typeof f.savedAt === 'string' ? f.savedAt : new Date(0).toISOString(),
    name: f.name ?? '未命名存档',
    levelId: f.levelId ?? level.id,
    seed: f.seed ?? level.seed,
    level,
    actions: Array.isArray(f.actions) ? f.actions : [],
    currentStep: typeof f.currentStep === 'number' ? f.currentStep : 0,
    score: typeof f.score === 'number' ? f.score : 0,
    finished: !!f.finished,
  };
}

export function parseReplayFile(raw: unknown): ReplayFile {
  if (!raw || typeof raw !== 'object') throw new Error('录像格式无效');
  const f = raw as Partial<ReplayFile>;
  if (f.format !== 'cascade-dispatch-replay') throw new Error('不是本游戏的录像文件');
  const level = migrateLevel(f.level);
  return {
    format: 'cascade-dispatch-replay',
    schemaVersion: SAVE_SCHEMA_VERSION,
    configVersion: level.configVersion,
    recordedAt: typeof f.recordedAt === 'string' ? f.recordedAt : new Date(0).toISOString(),
    level,
    actions: Array.isArray(f.actions) ? f.actions : [],
    resultSnapshot: f.resultSnapshot ?? { finalScore: 0, stars: 0, steps: 0, failed: false },
  };
}
