// 自动调度策略：输入引擎只读视图，输出本步操作。全部确定性、无随机
import { SimulationEngine, type EngineView } from './engine';
import { clamp } from './interp';
import type { LevelConfig, StationAction, StepAction } from './types';

export type AutoStrategy = (view: EngineView, level: LevelConfig) => StepAction;

function baseAction(maxUnits: number): StationAction {
  return { gateOpening: 0, activeUnits: maxUnits };
}

/** 策略1：发电优先 —— 满发，闸门只在接近汛限时开启 */
export const greedyPower: AutoStrategy = (view) => {
  const out: StepAction = {};
  for (const s of view.stations) {
    const a = baseAction(s.effectiveUnits);
    const margin = s.cfg.floodLimitLevel - s.cfg.deadLevel;
    const fillRatio = (s.level - s.cfg.deadLevel) / Math.max(1e-6, margin);
    if (fillRatio > 0.85) {
      a.gateOpening = clamp((fillRatio - 0.85) / 0.15, 0, 1);
    }
    out[s.cfg.id] = a;
  }
  return out;
};

/** 策略2：防洪优先 —— 水位一到汛限 70% 就加大泄量，逼近坝顶时全力泄洪，始终保留最低发电 */
export const floodFirst: AutoStrategy = (view) => {
  const out: StepAction = {};
  for (const s of view.stations) {
    const a = baseAction(s.effectiveUnits);
    const ratio = (s.level - s.cfg.deadLevel) / Math.max(1e-6, s.cfg.floodLimitLevel - s.cfg.deadLevel);
    if (ratio > 0.7) a.gateOpening = clamp((ratio - 0.7) / 0.3, 0.2, 1);
    // 水位越接近坝顶，闸门越接近全开；机组保留至少 1 台（除非无水可发）
    if (ratio > 0.95) a.gateOpening = 1;
    out[s.cfg.id] = a;
  }
  return out;
};

/** 策略3：平衡调度 —— 目标水位带 + 短临预报预泄，缺水时优先蓄水保供 */
export const balanced: AutoStrategy = (view, level) => {
  const out: StepAction = {};
  const supplyStressed = view.demand > view.outletFlow * 1.05; // 下游供水吃紧
  for (const s of view.stations) {
    const a = baseAction(s.effectiveUnits);
    const fc = view.forecastAt(s.cfg.id, 3);
    const fcPeak = fc.length ? Math.max(...fc) : s.inflow;
    const targetLow = s.cfg.deadLevel + (s.cfg.normalLevel - s.cfg.deadLevel) * 0.55;
    const targetHigh = s.cfg.normalLevel;

    if (supplyStressed && s.level < targetHigh && fcPeak <= s.inflow * 1.4) {
      // 缺水且无大水：关闸蓄水，同时保持满发——发电下泄流量正好承担供水
      a.gateOpening = 0;
      a.activeUnits = s.effectiveUnits;
    } else if (s.level > targetHigh) {
      a.gateOpening = clamp((s.level - targetHigh) / Math.max(1e-6, s.cfg.floodLimitLevel - targetHigh), 0.1, 0.8);
    } else if (s.level < targetLow) {
      a.gateOpening = 0;
    } else if (fcPeak > s.inflow * 1.6) {
      a.gateOpening = 0.35; // 预报有大水，提前预泄
    } else {
      a.gateOpening = 0.1;
    }
    out[s.cfg.id] = a;
  }
  return out;
};

/** 策略4：规则水位线 —— 按剩余步数动态消落，期末蓄到正常水位附近，汛期主动预泄、枯期保守蓄水 */
export const ruleCurve: AutoStrategy = (view, level) => {
  const out: StepAction = {};
  const progress = view.step / Math.max(1, view.horizon);
  for (const s of view.stations) {
    const a = baseAction(s.effectiveUnits);
    const fc = view.forecastAt(s.cfg.id, 3);
    const fcPeak = fc.length ? Math.max(...fc) : s.inflow;
    // 目标水位：前期偏低留防洪库容，后期回蓄至正常蓄水位 90%
    const target =
      s.cfg.deadLevel +
      (s.cfg.normalLevel - s.cfg.deadLevel) * (0.5 + 0.4 * progress);
    const diff = s.level - target;
    const dangerRatio =
      (s.level - s.cfg.deadLevel) / Math.max(1e-6, s.cfg.floodLimitLevel - s.cfg.deadLevel);
    if (dangerRatio > 0.9 || fcPeak > s.inflow * 1.8) {
      a.gateOpening = clamp(0.5 + dangerRatio * 0.5, 0.5, 1); // 预报大水或接近汛限，预泄
    } else if (diff > 1.0) {
      a.gateOpening = clamp(diff / 5, 0.15, 0.7);
    } else {
      a.gateOpening = 0; // 目标带内蓄水保供
    }
    out[s.cfg.id] = a;
  }
  return out;
};

export const STRATEGIES: { id: string; name: string; fn: AutoStrategy; desc: string }[] = [
  { id: 'greedy_power', name: '发电优先', fn: greedyPower, desc: '满发为主，逼近汛限才泄洪' },
  { id: 'flood_first', name: '防洪优先', fn: floodFirst, desc: '低水位运行，安全第一' },
  { id: 'balanced', name: '平衡调度', fn: balanced, desc: '目标水位带 + 预报预泄' },
  { id: 'rule_curve', name: '规则水位线', fn: ruleCurve, desc: '按调度规程动态消落回蓄' },
];

/** 用指定策略跑完整局，返回每步操作（供回放核对） */
export function runStrategy(level: LevelConfig, strategy: AutoStrategy): { actions: StepAction[] } {
  const engine = new SimulationEngine(level);
  const actions: StepAction[] = [];
  while (engine.currentStep < level.horizonSteps) {
    const a = strategy(engine.view(), level);
    actions.push(a);
    engine.step(a);
  }
  return { actions };
}
