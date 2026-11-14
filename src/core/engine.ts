// 梯级水库调度核心仿真引擎
// 关键不变量：
//  1) 纯确定性 —— 不使用 Math.random/Date.now，同关卡种子 + 同操作序列 => 逐位一致
//  2) 水量守恒 —— 每步 Δ蓄水 = 入流体积 - 出流体积（含河道槽蓄与损失单列）
//  3) 上游时滞 —— 上一级泄量按 routingWeights 分时滞到达下一级
import { activeEventsAt, generateEvents } from './events';
import { generateAllInflows } from './inflow';
import { clamp, interp, levelToStorage, storageToLevel, volumeToFlow } from './interp';
import type {
  GameEvent,
  LevelConfig,
  ScoreBreakdown,
  SimulationResult,
  SimulationSummary,
  StationAction,
  StationConfig,
  StationSnapshot,
  StepAction,
  StepRecord,
} from './types';

const DEAD_STORAGE_EPS = 1e-6;

function emptyBreakdown(): ScoreBreakdown {
  return { energy: 0, flood: 0, deficit: 0, band: 0, endStorage: 0, spill: 0, damFailure: 0, total: 0 };
}
function addBreakdown(a: ScoreBreakdown, b: ScoreBreakdown): ScoreBreakdown {
  return {
    energy: a.energy + b.energy,
    flood: a.flood + b.flood,
    deficit: a.deficit + b.deficit,
    band: a.band + b.band,
    endStorage: a.endStorage + b.endStorage,
    spill: a.spill + b.spill,
    damFailure: a.damFailure + b.damFailure,
    total: a.total + b.total,
  };
}

interface StationRuntime {
  cfg: StationConfig;
  storage: number;
  level: number;
  deadStorage: number;
  floodLimitStorage: number;
  damTopStorage: number;
  normalStorage: number;
}

interface ReachRuntime {
  from: string;
  to: string;
  lag: number;
  weights: number[];
  lossFactor: number;
  /** 每步上一级出库体积（按步索引） */
  releaseHistory: number[];
  /** 河道槽蓄体积（尚未到达下游的部分） */
  channelStorage: number;
  cumulativeLoss: number;
}

export interface EngineView {
  step: number;
  horizon: number;
  stations: {
    cfg: StationConfig;
    storage: number;
    level: number;
    inflow: number;
    totalRelease: number;
    powerMw: number;
    effectiveUnits: number;
    activeUnits: number;
    gateOpening: number;
    head: number;
  }[];
  demand: number;
  outletFlow: number;
  totalScore: number;
  failed: boolean;
  /** 未来 N 步的预报来水（按站），已叠加预报偏差事件 */
  forecastAt: (stationId: string, horizon: number) => number[];
  activeEvents: GameEvent[];
}

export class SimulationEngine {
  readonly level: LevelConfig;
  readonly events: GameEvent[];
  readonly naturalInflow: Record<string, number[]>;
  readonly forecast: Record<string, number[]>;
  readonly records: StepRecord[] = [];

  private stations: StationRuntime[] = [];
  private reaches: ReachRuntime[] = [];
  private upstreamReach = new Map<string, ReachRuntime>();
  private downstreamReach = new Map<string, ReachRuntime>();
  private cumulativeScore = 0;
  private cumulativeBreakdown = emptyBreakdown();
  private cumulativeEnergy = 0;
  private cumulativeSpill = 0;
  private cumulativeDeficitSteps = 0;
  private cumulativeNaturalInput = 0;
  private cumulativeRoutedInput = 0;
  private cumulativeOutlet = 0;
  private maxFloodLevel: Record<string, number> = {};
  private failed = false;
  private failureReason: string | undefined;
  private lastSnapshots: StationSnapshot[] = [];
  private lastDemand = 0;
  private lastOutlet = 0;
  private lastActive: GameEvent[] = [];

  constructor(level: LevelConfig) {
    this.level = level;
    this.events = generateEvents(level);
    this.naturalInflow = generateAllInflows(level);
    this.forecast = this.buildForecast();
    this.initRuntime();
  }

  private initRuntime(): void {
    this.stations = this.level.stations.map((cfg) => {
      const storage = clamp(cfg.initialStorage, levelToStorage(cfg.levelStorage, cfg.deadLevel), levelToStorage(cfg.levelStorage, cfg.damTopLevel));
      return {
        cfg,
        storage,
        level: storageToLevel(cfg.levelStorage, storage),
        deadStorage: levelToStorage(cfg.levelStorage, cfg.deadLevel),
        floodLimitStorage: levelToStorage(cfg.levelStorage, cfg.floodLimitLevel),
        damTopStorage: levelToStorage(cfg.levelStorage, cfg.damTopLevel),
        normalStorage: levelToStorage(cfg.levelStorage, cfg.normalLevel),
      };
    });
    this.maxFloodLevel = Object.fromEntries(this.level.stations.map((s) => [s.id, s.deadLevel]));

    this.reaches = this.level.reaches.map((r) => {
      const lag = Math.max(0, Math.floor(r.lagSteps));
      let weights = r.routingWeights && r.routingWeights.length === lag + 1 ? [...r.routingWeights] : undefined;
      if (!weights) {
        // 默认：全部水量在 lag 步后到达
        weights = new Array(lag + 1).fill(0);
        weights[lag] = 1;
      }
      const wSum = weights.reduce((a, b) => a + b, 0);
      weights = weights.map((w) => (wSum > 0 ? w / wSum : 0));
      return {
        from: r.fromStation,
        to: r.toStation,
        lag,
        weights,
        lossFactor: clamp(r.lossFactor ?? 0, 0, 0.5),
        releaseHistory: [],
        channelStorage: 0,
        cumulativeLoss: 0,
      };
    });
    for (const r of this.reaches) {
      this.upstreamReach.set(r.to, r);
      this.downstreamReach.set(r.from, r);
    }
  }

  /** 预报序列 = 天然来水叠加暴雨预报偏差（玩家看到的是不准的预报） */
  private buildForecast(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const st of this.level.stations) {
      const nat = this.naturalInflow[st.id] ?? [];
      const f = nat.slice();
      for (const ev of this.events.filter((e) => e.type === 'storm_bias')) {
        for (let t = ev.startStep; t <= ev.endStep; t++) {
          if (t < f.length) f[t] = Math.max(0, f[t] * (1 + (ev.biasRatio ?? 0)));
        }
      }
      out[st.id] = f;
    }
    return out;
  }

  private baseDemand(step: number): number {
    const segs = this.level.demand.segments;
    let flow = segs.length ? segs[0].flow : 0;
    for (const s of segs) {
      if (step >= s.startStep) flow = s.flow;
      else break;
    }
    return flow;
  }

  private demandAt(step: number, active: GameEvent[]): number {
    let d = this.baseDemand(step);
    for (const ev of active) {
      if (ev.type === 'demand_shift') d *= 1 + (ev.demandDelta ?? 0);
    }
    return Math.max(0, d);
  }

  private maintenanceDown(stationId: string, active: GameEvent[]): number {
    let down = 0;
    for (const ev of active) {
      if (ev.type === 'maintenance' && ev.stationId === stationId) down += ev.unitsDown ?? 0;
    }
    return down;
  }

  /** 河道在本步到达 to 站的入流体积；同时记录本步 from 站的泄量 */
  private routeRelease(reach: ReachRuntime, step: number, releaseVolume: number): void {
    const afterLoss = releaseVolume * (1 - reach.lossFactor);
    reach.cumulativeLoss += releaseVolume - afterLoss;
    reach.releaseHistory[step] = afterLoss;
    reach.channelStorage += afterLoss; // 进入河道
  }

  private routedInflow(reach: ReachRuntime, step: number): number {
    let v = 0;
    for (let k = 0; k < reach.weights.length; k++) {
      const past = reach.releaseHistory[step - k];
      if (past !== undefined) v += past * reach.weights[k];
    }
    // 离开河道（含本步进入且权重落在 k=0 的部分，保证槽蓄账闭合）
    reach.channelStorage -= v;
    if (reach.channelStorage < 1e-6) reach.channelStorage = 0;
    return v;
  }

  private normalizeAction(stationId: string, action: StationAction | undefined, maintenance: number): StationAction {
    const cfg = this.level.stations.find((s) => s.id === stationId)!;
    const maxUnits = Math.max(0, cfg.plant.unitCount - maintenance);
    return {
      gateOpening: clamp(action?.gateOpening ?? 0, 0, 1),
      activeUnits: clamp(Math.floor(action?.activeUnits ?? 0), 0, maxUnits),
    };
  }

  /** 推进一步。action 为各站操作；返回该步记录 */
  step(action: StepAction): StepRecord {
    const step = this.records.length;
    const dt = this.level.dtSeconds;
    const active = activeEventsAt(this.events, step);
    const demand = this.demandAt(step, active);
    const scoreDelta = emptyBreakdown();
    const snapshots: StationSnapshot[] = [];

    // 按站顺序（上游->下游）逐站处理：先结算本步河道到达，再水量平衡，再把出库放入下游河道。
    // 这样同一级链上 k=0 的槽蓄分量能在同一步正确到达下一级。
    for (const rt of this.stations) {
      const cfg = rt.cfg;
      const maintenance = this.maintenanceDown(cfg.id, active);
      const act = this.normalizeAction(cfg.id, action[cfg.id], maintenance);
      const effectiveUnits = act.activeUnits;

      const upReach = this.upstreamReach.get(cfg.id);
      const routedV = upReach ? this.routedInflow(upReach, step) : 0;
      const naturalQ = this.naturalInflow[cfg.id]?.[step] ?? 0;
      const routedQ = volumeToFlow(routedV, dt);
      const inflowQ = naturalQ + routedQ;
      const inflowV = inflowQ * dt;
      this.cumulativeNaturalInput += naturalQ * dt;
      this.cumulativeRoutedInput += routedV;

      // 水头按步初水位与坝下河槽基准估算（简化：head = level - deadLevel）
      const head = Math.max(0, rt.level - cfg.deadLevel);
      const headOk = head >= cfg.plant.minHead;
      const headFactor = clamp(head / cfg.plant.ratedHead, 0, 1);

      // 期望发电流量
      const desiredTurbineQ = headOk ? effectiveUnits * cfg.plant.unitFlow : 0;
      // 闸门泄流能力（按步初水位查曲线）
      const spillCapacityQ =
        cfg.spillway.gateCount * act.gateOpening * interp(cfg.spillway.capacityCurve, rt.level);

      // 可用于出库的体积上限：蓄水量 + 入流 - 死库容
      const releasableV = Math.max(0, rt.storage + inflowV - rt.deadStorage);
      let turbineV = desiredTurbineQ * dt;
      let spillV = spillCapacityQ * dt;

      // 水量约束：发电优先，剩余分配给泄洪
      if (turbineV + spillV > releasableV) {
        if (turbineV <= releasableV) {
          spillV = releasableV - turbineV;
        } else {
          turbineV = releasableV;
          spillV = 0;
        }
      }

      // 水量平衡更新（硬钳制：期末蓄水不得低于死库容，防止浮点/级联叠加把库算穿）
      let nextStorage = rt.storage + inflowV - turbineV - spillV;
      if (nextStorage < rt.deadStorage) {
        const overRelease = rt.deadStorage - nextStorage;
        // 先砍泄洪、再砍发电，保持发电优先口径
        const cutSpill = Math.min(spillV, overRelease);
        spillV -= cutSpill;
        const rest = overRelease - cutSpill;
        turbineV = Math.max(0, turbineV - rest);
        nextStorage = rt.storage + inflowV - turbineV - spillV;
      }

      // 坝顶漫坝：超过坝顶库容（含 1e-9 相对容差，避免浮点贴边误判）的水量强制溢流，
      // 计入出库并演进到下游，不得凭空消失
      let overflowV = 0;
      const overTol = rt.damTopStorage * 1e-9;
      if (nextStorage > rt.damTopStorage + overTol) {
        overflowV = nextStorage - rt.damTopStorage;
        nextStorage = rt.damTopStorage;
        // 漫坝判负与一次性扣分：每座库只在首次漫坝当步记录，后续步不重复扣
        const alreadyFailed = this.failed;
        if (!alreadyFailed) {
          this.failed = true;
          this.failureReason = `${cfg.name} 水位超过坝顶，发生漫坝溢流`;
          scoreDelta.damFailure -= this.level.scoring.damFailurePenalty;
        }
      }

      // 总出库 = 发电 + 可控泄洪 + 漫坝溢流，三者都进入下游河道，保证系统闭合
      const totalReleaseV = turbineV + spillV + overflowV;
      rt.storage = nextStorage;
      rt.level = storageToLevel(cfg.levelStorage, nextStorage);
      this.maxFloodLevel[cfg.id] = Math.max(this.maxFloodLevel[cfg.id], rt.level);

      // 功率与电量（实际发电流量不足时按比例折减）
      const turbineQ = volumeToFlow(turbineV, dt);
      const flowFactor = desiredTurbineQ > 0 ? clamp(turbineQ / desiredTurbineQ, 0, 1) : 0;
      const powerMw = effectiveUnits * cfg.plant.unitPower * headFactor * flowFactor;
      const energyMwh = powerMw * (dt / 3600);
      this.cumulativeEnergy += energyMwh;
      this.cumulativeSpill += spillV + overflowV;

      // 河道演进：本步出库量进入下游河道
      const downReach = this.downstreamReach.get(cfg.id);
      if (downReach) this.routeRelease(downReach, step, totalReleaseV);

      // 评分
      scoreDelta.energy += energyMwh * this.level.scoring.pointsPerMwh;
      if (rt.level > cfg.floodLimitLevel) {
        scoreDelta.flood -= (rt.level - cfg.floodLimitLevel) * this.level.scoring.floodPenaltyPerMeterStep;
      }
      if (rt.level >= cfg.deadLevel && rt.level <= cfg.normalLevel) {
        scoreDelta.band += this.level.scoring.bandRewardPerStep;
      }
      scoreDelta.spill -= (spillV + overflowV) * this.level.scoring.spillPenaltyPerM3;

      snapshots.push({
        stationId: cfg.id,
        storage: nextStorage,
        level: rt.level,
        inflow: inflowQ,
        turbineRelease: turbineQ,
        spillRelease: volumeToFlow(spillV + overflowV, dt),
        totalRelease: volumeToFlow(totalReleaseV, dt),
        overflow: volumeToFlow(overflowV, dt),
        powerMw,
        energyMwh,
        gateOpening: act.gateOpening,
        activeUnits: act.activeUnits,
        effectiveUnits,
        head,
      });
    }

    // 下游供水：取最末级出库
    const last = snapshots[snapshots.length - 1];
    const outletFlow = last.totalRelease;
    this.cumulativeOutlet += outletFlow * dt;
    const supplyRatio = demand > 0 ? clamp(outletFlow / demand, 0, 1) : 1;
    if (demand > outletFlow) {
      scoreDelta.deficit -= (demand - outletFlow) * this.level.scoring.deficitPenaltyPerCms;
      this.cumulativeDeficitSteps++;
    }

    // 末步蓄水奖励
    if (step === this.level.horizonSteps - 1) {
      for (const rt of this.stations) {
        const aboveDead = Math.max(0, rt.storage - rt.deadStorage);
        scoreDelta.endStorage += aboveDead * this.level.scoring.endStorageRewardPerM3;
      }
    }

    scoreDelta.total =
      scoreDelta.energy +
      scoreDelta.flood +
      scoreDelta.deficit +
      scoreDelta.band +
      scoreDelta.endStorage +
      scoreDelta.spill +
      scoreDelta.damFailure;
    this.cumulativeScore += scoreDelta.total;
    this.cumulativeBreakdown = addBreakdown(this.cumulativeBreakdown, scoreDelta);

    // 守恒审计（系统边界闭合，内部转输不重复计）：
    //   期初蓄水 + 累计天然来水 = 当前蓄水 + 河道槽蓄 + 累计最下游出口 + 累计河道损失
    const currentStorage = this.stations.reduce((a, s) => a + s.storage, 0);
    const channelStorage = this.reaches.reduce((a, r) => a + r.channelStorage, 0);
    const loss = this.reaches.reduce((a, r) => a + r.cumulativeLoss, 0);
    // 期初蓄水直接取配置原值，禁止用库容反查水位库容曲线（量纲不符）
    const initialStorage = this.stations.reduce((a, s) => a + s.cfg.initialStorage, 0);
    const lhs = initialStorage + this.cumulativeNaturalInput;
    const rhs = currentStorage + channelStorage + this.cumulativeOutlet + loss;
    const systemWater = currentStorage + channelStorage;
    const conservationError = Math.abs(lhs - rhs) / Math.max(1, this.cumulativeNaturalInput);

    const record: StepRecord = {
      step,
      stations: snapshots,
      outletFlow,
      demand,
      supplyRatio,
      scoreDelta,
      totalScore: this.cumulativeScore,
      activeEventIds: active.map((e) => e.id),
      systemWater,
    };
    this.records.push(record);
    this.lastSnapshots = snapshots;
    this.lastDemand = demand;
    this.lastOutlet = outletFlow;
    this.lastActive = active;
    return record;
  }

  /** 一次性跑完整操作序列（自动策略/回放/批量模拟用）；漫坝后标记失败但继续跑完全程 */
  run(actions: StepAction[]): SimulationResult {
    while (this.records.length < this.level.horizonSteps) {
      const a = actions[this.records.length] ?? {};
      this.step(a);
    }
    return this.result();
  }

  get currentStep(): number {
    return this.records.length;
  }

  /** 步数走完即结束；漫坝只置失败标记，不截断记录（保证录像完整、水量闭合） */
  get isFinished(): boolean {
    return this.records.length >= this.level.horizonSteps;
  }

  /** 是否发生过漫坝（判负） */
  get hasFailed(): boolean {
    return this.failed;
  }

  get scoreBreakdown(): ScoreBreakdown {
    return this.cumulativeBreakdown;
  }

  get conservationError(): number {
    if (this.records.length === 0) return 0;
    return this.records[this.records.length - 1]
      ? this.lastConservationError()
      : 0;
  }

  private lastConservationError(): number {
    const currentStorage = this.stations.reduce((a, s) => a + s.storage, 0);
    const channelStorage = this.reaches.reduce((a, r) => a + r.channelStorage, 0);
    const loss = this.reaches.reduce((a, r) => a + r.cumulativeLoss, 0);
    const initialStorage = this.stations.reduce((a, s) => a + s.cfg.initialStorage, 0);
    const lhs = initialStorage + this.cumulativeNaturalInput;
    const rhs = currentStorage + channelStorage + this.cumulativeOutlet + loss;
    return Math.abs(lhs - rhs) / Math.max(1, this.cumulativeNaturalInput);
  }

  /** 供 UI/策略使用的只读视图 */
  view(): EngineView {
    return {
      step: this.records.length,
      horizon: this.level.horizonSteps,
      stations: this.stations.map((rt, i) => {
        const snap = this.lastSnapshots[i];
        const maintenance = this.maintenanceDown(rt.cfg.id, this.lastActive);
        return {
          cfg: rt.cfg,
          storage: rt.storage,
          level: rt.level,
          inflow: snap?.inflow ?? this.naturalInflow[rt.cfg.id]?.[this.records.length] ?? 0,
          totalRelease: snap?.totalRelease ?? 0,
          powerMw: snap?.powerMw ?? 0,
          effectiveUnits: snap?.effectiveUnits ?? Math.max(0, rt.cfg.plant.unitCount - maintenance),
          activeUnits: snap?.activeUnits ?? 0,
          gateOpening: snap?.gateOpening ?? 0,
          head: snap?.head ?? Math.max(0, rt.level - rt.cfg.deadLevel),
        };
      }),
      demand: this.lastDemand,
      outletFlow: this.lastOutlet,
      totalScore: this.cumulativeScore,
      failed: this.failed,
      forecastAt: (stationId: string, horizon: number) => {
        const f = this.forecast[stationId] ?? [];
        const from = this.records.length;
        return f.slice(from, from + horizon);
      },
      activeEvents: this.lastActive,
    };
  }

  result(): SimulationResult {
    const steps = this.records.length;
    const reliability =
      steps > 0 ? this.records.reduce((a, r) => a + r.supplyRatio, 0) / steps : 1;
    const finalScore = this.cumulativeScore;
    const t = this.level.scoring.starThresholds;
    const stars = this.failed
      ? 0
      : finalScore >= t.three
        ? 3
        : finalScore >= t.two
          ? 2
          : finalScore >= t.one
            ? 1
            : 0;
    const summary: SimulationSummary = {
      finished: !this.failed && steps >= this.level.horizonSteps,
      failed: this.failed,
      failureReason: this.failureReason,
      finalScore,
      stars,
      totalEnergyMwh: this.cumulativeEnergy,
      totalSpillM3: this.cumulativeSpill,
      supplyReliability: reliability,
      maxFloodLevel: this.maxFloodLevel,
      conservationError: this.lastConservationError(),
      steps,
    };
    return {
      levelId: this.level.id,
      seed: this.level.seed,
      records: this.records,
      summary,
      events: this.events,
      forecast: this.forecast,
      naturalInflow: this.naturalInflow,
    };
  }
}

/** 便捷函数：整局运行 */
export function simulate(level: LevelConfig, actions: StepAction[]): SimulationResult {
  return new SimulationEngine(level).run(actions);
}
