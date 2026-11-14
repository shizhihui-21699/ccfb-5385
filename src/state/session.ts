// 对局会话：封装引擎 + 操作历史，支持手动推进、自动演示与逐帧回放
import { SimulationEngine, type EngineView } from '../core/engine';
import type { LevelConfig, StepAction, StepRecord, SimulationResult } from '../core/types';

export class GameSession {
  readonly level: LevelConfig;
  readonly engine: SimulationEngine;
  readonly actions: StepAction[] = [];
  readonly replayActions: StepAction[] | null;
  readonly isReplay: boolean;

  constructor(level: LevelConfig, opts: { resumeActions?: StepAction[]; replayActions?: StepAction[] } = {}) {
    this.level = level;
    this.engine = new SimulationEngine(level);
    this.isReplay = !!opts.replayActions;
    this.replayActions = opts.replayActions ?? null;
    // 续档：重放到历史步
    const history = opts.replayActions ?? opts.resumeActions ?? [];
    for (const a of history) {
      if (this.engine.currentStep >= level.horizonSteps) break;
      this.engine.step(a);
      this.actions.push(structuredClone(a));
    }
  }

  get step(): number {
    return this.engine.currentStep;
  }
  get horizon(): number {
    return this.level.horizonSteps;
  }
  get finished(): boolean {
    return this.engine.currentStep >= this.level.horizonSteps;
  }
  get failed(): boolean {
    return this.engine.hasFailed;
  }
  get view(): EngineView {
    return this.engine.view();
  }
  get records(): StepRecord[] {
    return this.engine.records;
  }

  /** 玩家手动推进一步 */
  applyStep(action: StepAction): StepRecord {
    if (this.finished) throw new Error('对局已结束');
    const rec = this.engine.step(action);
    this.actions.push(structuredClone(action));
    return rec;
  }

  /** 回放模式：按录像推进当前步 */
  replayNext(): StepRecord | null {
    if (!this.replayActions || this.finished) return null;
    const a = this.replayActions[this.engine.currentStep] ?? {};
    const rec = this.engine.step(a);
    this.actions.push(structuredClone(a));
    return rec;
  }

  result(): SimulationResult {
    return this.engine.result();
  }
}
