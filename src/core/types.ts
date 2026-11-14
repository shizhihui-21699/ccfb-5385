// 全局类型定义：数值全部走配置表，引擎不写死业务常数

/** 水位-库容曲线上的一个点 */
export interface LevelStoragePoint {
  /** 水位 m（相对基准，展示用） */
  level: number;
  /** 库容 m³ */
  storage: number;
}

/** 水位-面积/泄流能力等通用折线点 */
export interface XYPoint {
  x: number;
  y: number;
}

/** 泄洪闸配置 */
export interface SpillwayConfig {
  /** 闸门数量 */
  gateCount: number;
  /** 单孔全开泄流能力曲线：key=水位(m), value=单孔流量 m³/s */
  capacityCurve: XYPoint[];
}

/** 电站机组配置 */
export interface PlantConfig {
  /** 机组台数上限 */
  unitCount: number;
  /** 单机额定流量 m³/s */
  unitFlow: number;
  /** 单机额定功率 MW */
  unitPower: number;
  /** 最小发电水头 m（低于则机组不可用） */
  minHead: number;
  /** 发电水头折减系数（水头越低出力越小，线性折减起点） */
  ratedHead: number;
}

/** 单座水库/电站配置 */
export interface StationConfig {
  id: string;
  name: string;
  /** 展示位置（Canvas 布局用，0~1 相对坐标） */
  layout: { x: number; y: number };
  /** 水位库容曲线（必须按 level 升序，storage 升序） */
  levelStorage: LevelStoragePoint[];
  /** 死水位 m */
  deadLevel: number;
  /** 汛限水位 m，超过扣分 */
  floodLimitLevel: number;
  /** 坝顶/最高水位 m，超过判定溃坝 */
  damTopLevel: number;
  /** 正常蓄水位 m（最优运行带上限） */
  normalLevel: number;
  /** 初始库容 m³ */
  initialStorage: number;
  spillway: SpillwayConfig;
  plant: PlantConfig;
}

/** 库间河道（站 i 的退水汇入站 i+1） */
export interface ReachConfig {
  id: string;
  fromStation: string;
  toStation: string;
  /** 水流时滞，单位：步（dt 为 6 小时） */
  lagSteps: number;
  /** 河道槽蓄分配权重（长度=lagSteps+1，和为 1）；默认全部落在 lagSteps 上 */
  routingWeights?: number[];
  /** 河道损失系数 0~1（默认 0，保证守恒；非 0 时审计单列损失项） */
  lossFactor?: number;
}

/** 下游供水需求剖面（分段常数，按步索引） */
export interface DemandProfile {
  /** [起始步, 流量 m³/s]，按 startStep 升序 */
  segments: { startStep: number; flow: number }[];
}

/** 突发事件生成配置 */
export interface EventConfig {
  /** 暴雨预报偏差事件 */
  stormForecastBias: {
    enabled: boolean;
    count: number;
    /** 偏差幅度（相对误差，0.3 = ±30%） */
    magnitude: number;
    /** 影响持续步数 */
    durationSteps: number;
  };
  /** 机组检修事件 */
  maintenance: {
    enabled: boolean;
    count: number;
    /** 检修持续步数 */
    durationSteps: number;
    /** 每次检修减少的机组台数 */
    unitsDown: number;
  };
  /** 下游抽水需求变化事件 */
  demandShift: {
    enabled: boolean;
    count: number;
    durationSteps: number;
    /** 需求变化比例（0.5 = 增加 50%，-0.3 = 减少 30%） */
    magnitude: number;
  };
}

/** 评分权重与阈值（全部可配置） */
export interface ScoringConfig {
  /** 每 MWh 得分 */
  pointsPerMwh: number;
  /** 每超汛限 1m·步 的扣分 */
  floodPenaltyPerMeterStep: number;
  /** 供水每缺 1 m³/s（步均）的扣分 */
  deficitPenaltyPerCms: number;
  /** 水位处于[死水位, 正常蓄水位]区间每步得分 */
  bandRewardPerStep: number;
  /** 末步蓄水奖励：每 m³ 得分（鼓励蓄丰补枯） */
  endStorageRewardPerM3: number;
  /** 弃水（超发电流量的下泄）每 m³ 扣分 */
  spillPenaltyPerM3: number;
  /** 溃坝一次性扣分（并直接判负） */
  damFailurePenalty: number;
  /** 星级阈值（总分） */
  starThresholds: { one: number; two: number; three: number };
}

/** 完整关卡配置 */
export interface LevelConfig {
  configVersion: number;
  id: string;
  name: string;
  description: string;
  /** 仿真总步数 */
  horizonSteps: number;
  /** 每步秒数（默认 21600 = 6h） */
  dtSeconds: number;
  seed: string;
  stations: StationConfig[];
  reaches: ReachConfig[];
  /** 最上游各站的天然来水参数（按 stationId） */
  inflow: Record<string, InflowSeriesConfig>;
  demand: DemandProfile;
  events: EventConfig;
  scoring: ScoringConfig;
}

/** 来水过程生成参数（种子随机，分段基流 + 季节过程 + 暴雨脉冲） */
export interface InflowSeriesConfig {
  /** 基流 m³/s */
  baseFlow: number;
  /** 季节正弦振幅 m³/s */
  seasonalAmplitude: number;
  /** 季节过程周期（步） */
  seasonalPeriodSteps: number;
  /** 噪声标准差比例（相对基流） */
  noiseRatio: number;
  /** 暴雨脉冲个数 */
  stormCount: number;
  /** 暴雨峰值范围 m³/s（相对基流的倍数上下限） */
  stormPeakMultiplier: [number, number];
  /** 暴雨持续步数范围 */
  stormDurationRange: [number, number];
}

/** 玩家在某一步对某座库的操作 */
export interface StationAction {
  /** 闸门开度 0~1（作用于全部闸门） */
  gateOpening: number;
  /** 开机台数（整数 0~unitCount） */
  activeUnits: number;
}

/** 一步的完整操作 */
export type StepAction = Record<string, StationAction>;

/** 突发事件实例（预生成，确定性） */
export interface GameEvent {
  id: number;
  type: 'storm_bias' | 'maintenance' | 'demand_shift';
  stationId?: string;
  startStep: number;
  endStep: number;
  /** 预报偏差比例（仅 storm_bias） */
  biasRatio?: number;
  /** 检修减少机组数（仅 maintenance） */
  unitsDown?: number;
  /** 需求变化比例（仅 demand_shift） */
  demandDelta?: number;
  title: string;
  detail: string;
}

/** 单站单步快照 */
export interface StationSnapshot {
  stationId: string;
  storage: number;
  level: number;
  inflow: number;
  turbineRelease: number;
  spillRelease: number;
  totalRelease: number;
  overflow: number;
  powerMw: number;
  energyMwh: number;
  gateOpening: number;
  activeUnits: number;
  effectiveUnits: number;
  head: number;
}

/** 一步的完整记录 */
export interface StepRecord {
  step: number;
  stations: StationSnapshot[];
  /** 最下游出口流量 m³/s */
  outletFlow: number;
  /** 下游需求 m³/s（含事件修正） */
  demand: number;
  /** 供水满足比例 0~1 */
  supplyRatio: number;
  /** 本步得分明细 */
  scoreDelta: ScoreBreakdown;
  /** 本步累计总分 */
  totalScore: number;
  /** 截至本步激活的事件 id */
  activeEventIds: number[];
  /** 本步系统总水量（含河道槽蓄），守恒审计用 */
  systemWater: number;
}

export interface ScoreBreakdown {
  energy: number;
  flood: number;
  deficit: number;
  band: number;
  endStorage: number;
  spill: number;
  damFailure: number;
  total: number;
}

/** 仿真结束摘要 */
export interface SimulationSummary {
  finished: boolean;
  failed: boolean;
  failureReason?: string;
  finalScore: number;
  stars: number;
  totalEnergyMwh: number;
  totalSpillM3: number;
  supplyReliability: number;
  maxFloodLevel: Record<string, number>;
  conservationError: number;
  steps: number;
}

/** 仿真全量结果 */
export interface SimulationResult {
  levelId: string;
  seed: string;
  records: StepRecord[];
  summary: SimulationSummary;
  events: GameEvent[];
  /** 每站预报来水（展示用，已含暴雨偏差事件影响） */
  forecast: Record<string, number[]>;
  /** 每站实际天然来水 */
  naturalInflow: Record<string, number[]>;
}
