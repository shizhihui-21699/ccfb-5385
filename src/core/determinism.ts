// 确定性校验：同一关卡 + 同一操作序列跑两次，结果必须逐字段一致
import { SimulationEngine } from './engine';
import { STRATEGIES } from './strategies';
import type { LevelConfig, StepAction } from './types';

export interface DeterminismCheckResult {
  ok: boolean;
  reason?: string;
  firstHash: string;
  secondHash: string;
}

/** FNV-1a 字符串哈希（32bit），用于结果指纹 */
export function fingerprint(obj: unknown): string {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function checkDeterminism(level: LevelConfig, actions: StepAction[]): DeterminismCheckResult {
  const r1 = new SimulationEngine(level).run(actions.map((a) => structuredClone(a)));
  const r2 = new SimulationEngine(level).run(actions.map((a) => structuredClone(a)));
  const h1 = fingerprint(r1.records);
  const h2 = fingerprint(r2.records);
  return {
    ok: h1 === h2,
    reason: h1 === h2 ? undefined : '两次运行记录指纹不一致',
    firstHash: h1,
    secondHash: h2,
  };
}

/** 用各自动策略各自跑一遍并交叉核对 */
export function checkAllStrategiesDeterminism(level: LevelConfig): DeterminismCheckResult[] {
  return STRATEGIES.map((s) => {
    const engine = new SimulationEngine(level);
    const actions: StepAction[] = [];
    while (engine.currentStep < level.horizonSteps) {
      const a = s.fn(engine.view(), level);
      actions.push(a);
      engine.step(a);
    }
    return checkDeterminism(level, actions);
  });
}
