// 平衡模拟：多策略 × 多种子批量跑局，输出胜率与得分分布
import { SimulationEngine } from './engine';
import { STRATEGIES } from './strategies';
import type { LevelConfig, SimulationResult, StepAction } from './types';

export interface BatchRunRow {
  seed: string;
  strategyId: string;
  strategyName: string;
  score: number;
  stars: number;
  failed: boolean;
  supplyReliability: number;
  energyMwh: number;
  spillM3: number;
  conservationError: number;
  steps: number;
}

export interface ScoreBucket {
  label: string;
  count: number;
}

export interface StrategyStats {
  strategyId: string;
  strategyName: string;
  runs: number;
  winRate: number; // 拿到至少 1 星的比例
  threeStarRate: number;
  failureRate: number;
  avgScore: number;
  minScore: number;
  maxScore: number;
  medianScore: number;
  avgReliability: number;
  avgConservationError: number;
  distribution: ScoreBucket[];
}

export interface BatchReport {
  levelId: string;
  seedCount: number;
  rows: BatchRunRow[];
  stats: StrategyStats[];
  generatedAt?: string;
}

/** 由基础种子派生第 i 个批量种子（确定性） */
export function deriveBatchSeed(baseSeed: string, i: number): string {
  return `${baseSeed}#batch${i}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildDistribution(scores: number[]): ScoreBucket[] {
  if (scores.length === 0) return [];
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const bucketCount = 8;
  const width = hi > lo ? (hi - lo) / bucketCount : 1;
  const buckets: ScoreBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    label: `${Math.round(lo + i * width)}~${Math.round(lo + (i + 1) * width)}`,
    count: 0,
  }));
  for (const s of scores) {
    let idx = Math.floor((s - lo) / width);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count++;
  }
  return buckets;
}

/** 跑一批：每个策略 × seedCount 个派生种子 */
export function runBatch(level: LevelConfig, seedCount: number, strategyIds?: string[]): BatchReport {
  const strategies = STRATEGIES.filter((s) => !strategyIds || strategyIds.includes(s.id));
  const rows: BatchRunRow[] = [];

  for (let i = 0; i < seedCount; i++) {
    const seed = deriveBatchSeed(level.seed, i);
    const variant: LevelConfig = { ...level, seed };
    for (const st of strategies) {
      const engine = new SimulationEngine(variant);
      const actions: StepAction[] = [];
      while (engine.currentStep < variant.horizonSteps) {
        const a = st.fn(engine.view(), variant);
        actions.push(a);
        engine.step(a);
      }
      const res: SimulationResult = engine.result();
      rows.push({
        seed,
        strategyId: st.id,
        strategyName: st.name,
        score: res.summary.finalScore,
        stars: res.summary.stars,
        failed: res.summary.failed,
        supplyReliability: res.summary.supplyReliability,
        energyMwh: res.summary.totalEnergyMwh,
        spillM3: res.summary.totalSpillM3,
        conservationError: res.summary.conservationError,
        steps: res.summary.steps,
      });
    }
  }

  const stats: StrategyStats[] = strategies.map((st) => {
    const mine = rows.filter((r) => r.strategyId === st.id);
    const scores = mine.map((r) => r.score).sort((a, b) => a - b);
    const wins = mine.filter((r) => r.stars >= 1).length;
    const threes = mine.filter((r) => r.stars >= 3).length;
    const fails = mine.filter((r) => r.failed).length;
    return {
      strategyId: st.id,
      strategyName: st.name,
      runs: mine.length,
      winRate: wins / Math.max(1, mine.length),
      threeStarRate: threes / Math.max(1, mine.length),
      failureRate: fails / Math.max(1, mine.length),
      avgScore: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length),
      minScore: scores[0] ?? 0,
      maxScore: scores[scores.length - 1] ?? 0,
      medianScore: percentile(scores, 0.5),
      avgReliability: mine.reduce((a, r) => a + r.supplyReliability, 0) / Math.max(1, mine.length),
      avgConservationError: mine.reduce((a, r) => a + r.conservationError, 0) / Math.max(1, mine.length),
      distribution: buildDistribution(scores),
    };
  });

  return { levelId: level.id, seedCount, rows, stats };
}
