// 默认配置数据：四座梯级电站 + 三个预置关卡。所有业务数值集中于此，可被编辑器/导入 JSON 覆盖
import type {
  EventConfig,
  InflowSeriesConfig,
  LevelConfig,
  LevelStoragePoint,
  ScoringConfig,
  StationConfig,
  ReachConfig,
} from '../core/types';

export const CURRENT_CONFIG_VERSION = 2;
const DT = 21600; // 6 小时一步

/** 生成水位库容曲线：库容随水位近似二次增长（V = k*(h-h0)^2 + 底库容） */
function makeLevelStorage(
  deadLevel: number,
  damTop: number,
  bottomStorage: number,
  fullStorage: number,
): LevelStoragePoint[] {
  const pts: LevelStoragePoint[] = [];
  const span = damTop - deadLevel;
  for (let h = deadLevel; h <= damTop + 0.001; h += 5) {
    const t = (h - deadLevel) / span;
    const storage = bottomStorage + (fullStorage - bottomStorage) * (0.15 * t + 0.85 * t * t);
    pts.push({ level: Math.round(h * 10) / 10, storage: Math.round(storage) });
  }
  // 保证端点精确
  pts[0] = { level: deadLevel, storage: bottomStorage };
  pts[pts.length - 1] = { level: damTop, storage: fullStorage };
  return pts;
}

/** 单孔闸门泄流能力曲线（随水位升高而增大，低水头保留基础开度，避免漫坝无解） */
function gateCurve(deadLevel: number, damTop: number, maxSingleGate: number) {
  const pts = [];
  for (let h = deadLevel; h <= damTop + 0.001; h += 5) {
    const t = (h - deadLevel) / (damTop - deadLevel);
    // 0.45 基础 + 0.55√t：死水位处仍有 45% 能力，保证可放空
    const y = maxSingleGate * (0.45 + 0.55 * Math.sqrt(Math.max(0, t)));
    pts.push({ x: Math.round(h * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return pts;
}

interface StationSpec {
  id: string;
  name: string;
  x: number;
  y: number;
  dead: number;
  normal: number;
  flood: number;
  damTop: number;
  bottomStorage: number;
  fullStorage: number;
  gateCount: number;
  maxSingleGate: number;
  unitCount: number;
  unitFlow: number;
  unitPower: number;
  minHead: number;
  ratedHead: number;
}

const STATION_SPECS: StationSpec[] = [
  {
    id: 'A', name: '青龙峡水库', x: 0.12, y: 0.22,
    dead: 240, normal: 285, flood: 290, damTop: 298,
    bottomStorage: 80_000_000, fullStorage: 1_200_000_000,
    gateCount: 4, maxSingleGate: 520,
    unitCount: 4, unitFlow: 260, unitPower: 180, minHead: 25, ratedHead: 42,
  },
  {
    id: 'B', name: '白沙江电站', x: 0.38, y: 0.42,
    dead: 175, normal: 205, flood: 209, damTop: 215,
    bottomStorage: 40_000_000, fullStorage: 520_000_000,
    gateCount: 3, maxSingleGate: 620,
    unitCount: 3, unitFlow: 300, unitPower: 130, minHead: 18, ratedHead: 30,
  },
  {
    id: 'C', name: '云溪口枢纽', x: 0.62, y: 0.3,
    dead: 120, normal: 146, flood: 150, damTop: 156,
    bottomStorage: 25_000_000, fullStorage: 300_000_000,
    gateCount: 3, maxSingleGate: 680,
    unitCount: 3, unitFlow: 320, unitPower: 95, minHead: 14, ratedHead: 26,
  },
  {
    id: 'D', name: '望江岭电站', x: 0.87, y: 0.5,
    dead: 70, normal: 92, flood: 95, damTop: 100,
    bottomStorage: 12_000_000, fullStorage: 140_000_000,
    gateCount: 3, maxSingleGate: 950,
    unitCount: 2, unitFlow: 340, unitPower: 60, minHead: 10, ratedHead: 20,
  },
];

export function buildStations(initialRatio = 0.6): StationConfig[] {
  return STATION_SPECS.map((s) => {
    const levelStorage = makeLevelStorage(s.dead, s.damTop, s.bottomStorage, s.fullStorage);
    const initialStorage = Math.round(s.bottomStorage + (s.fullStorage - s.bottomStorage) * initialRatio);
    return {
      id: s.id,
      name: s.name,
      layout: { x: s.x, y: s.y },
      levelStorage,
      deadLevel: s.dead,
      floodLimitLevel: s.flood,
      damTopLevel: s.damTop,
      normalLevel: s.normal,
      initialStorage,
      spillway: { gateCount: s.gateCount, capacityCurve: gateCurve(s.dead, s.damTop, s.maxSingleGate) },
      plant: {
        unitCount: s.unitCount,
        unitFlow: s.unitFlow,
        unitPower: s.unitPower,
        minHead: s.minHead,
        ratedHead: s.ratedHead,
      },
    };
  });
}

export function buildReaches(): ReachConfig[] {
  return [
    { id: 'R_AB', fromStation: 'A', toStation: 'B', lagSteps: 2, lossFactor: 0 },
    { id: 'R_BC', fromStation: 'B', toStation: 'C', lagSteps: 2, lossFactor: 0 },
    { id: 'R_CD', fromStation: 'C', toStation: 'D', lagSteps: 1, lossFactor: 0 },
  ];
}

const DEFAULT_EVENTS: EventConfig = {
  stormForecastBias: { enabled: true, count: 3, magnitude: 0.35, durationSteps: 6 },
  maintenance: { enabled: true, count: 2, durationSteps: 8, unitsDown: 1 },
  demandShift: { enabled: true, count: 3, durationSteps: 10, magnitude: 0.5 },
};

const DEFAULT_SCORING: ScoringConfig = {
  // 满发全程约 1.1M MWh，×0.002 ≈ 2200 分，与其他科目同量级
  pointsPerMwh: 0.002,
  floodPenaltyPerMeterStep: 8,
  deficitPenaltyPerCms: 0.3,
  bandRewardPerStep: 4,
  endStorageRewardPerM3: 1e-8,
  spillPenaltyPerM3: 5e-9,
  damFailurePenalty: 3000,
  starThresholds: { one: 800, two: 1500, three: 2400 },
};

function inflowSet(scale: number, stormCount: number, noise: number): Record<string, InflowSeriesConfig> {
  const bases: Record<string, number> = { A: 420, B: 180, C: 140, D: 90 };
  const peak: [number, number] = [2.2, 4.5];
  const duration: [number, number] = [4, 10];
  return Object.fromEntries(
    Object.entries(bases).map(([id, base]) => [
      id,
      {
        baseFlow: Math.round(base * scale),
        seasonalAmplitude: Math.round(base * 0.25 * scale),
        seasonalPeriodSteps: 48,
        noiseRatio: noise,
        stormCount,
        stormPeakMultiplier: peak,
        stormDurationRange: duration,
      } satisfies InflowSeriesConfig,
    ]),
  );
}

function makeLevel(partial: {
  id: string;
  name: string;
  description: string;
  seed: string;
  horizonSteps: number;
  inflowScale: number;
  stormCount: number;
  noise: number;
  demandBase: number;
  events?: Partial<EventConfig>;
  scoring?: Partial<ScoringConfig>;
}): LevelConfig {
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    id: partial.id,
    name: partial.name,
    description: partial.description,
    horizonSteps: partial.horizonSteps,
    dtSeconds: DT,
    seed: partial.seed,
    stations: buildStations(),
    reaches: buildReaches(),
    inflow: inflowSet(partial.inflowScale, partial.stormCount, partial.noise),
    demand: {
      segments: [
        { startStep: 0, flow: partial.demandBase },
        { startStep: Math.floor(partial.horizonSteps * 0.4), flow: Math.round(partial.demandBase * 1.35) },
        { startStep: Math.floor(partial.horizonSteps * 0.75), flow: Math.round(partial.demandBase * 0.9) },
      ],
    },
    events: { ...DEFAULT_EVENTS, ...partial.events },
    scoring: { ...DEFAULT_SCORING, ...partial.scoring },
  };
}

export function buildDefaultLevels(): LevelConfig[] {
  return [
    makeLevel({
      id: 'lv_training',
      name: '入门演练：常规调度',
      description: '来水平稳、突发事件少。熟悉闸门开度、机组台数与四项评分的关系。',
      seed: 'TRAIN-2026-A',
      horizonSteps: 96,
      inflowScale: 0.9,
      stormCount: 2,
      noise: 0.06,
      demandBase: 350,
      events: {
        stormForecastBias: { enabled: true, count: 1, magnitude: 0.3, durationSteps: 6 },
        maintenance: { enabled: true, count: 1, durationSteps: 6, unitsDown: 1 },
        demandShift: { enabled: true, count: 1, durationSteps: 8, magnitude: 0.4 },
      },
    }),
    makeLevel({
      id: 'lv_flood',
      name: '汛期防洪：连续暴雨',
      description: '多轮暴雨过程叠加预报偏差，防洪压力大，超汛限即重扣。',
      seed: 'FLOOD-2026-B',
      horizonSteps: 120,
      inflowScale: 1.25,
      stormCount: 6,
      noise: 0.12,
      demandBase: 300,
      scoring: { floodPenaltyPerMeterStep: 16, starThresholds: { one: 600, two: 1300, three: 2200 } },
    }),
    makeLevel({
      id: 'lv_drought',
      name: '枯水保供：蓄水博弈',
      description: '来水偏枯、下游抽水需求高，考验蓄丰补枯与供水保证率。',
      seed: 'DROUGHT-2026-C',
      horizonSteps: 120,
      inflowScale: 0.62,
      stormCount: 1,
      noise: 0.05,
      demandBase: 360,
      scoring: { deficitPenaltyPerCms: 0.22, starThresholds: { one: 400, two: 1000, three: 1800 } },
    }),
  ];
}
