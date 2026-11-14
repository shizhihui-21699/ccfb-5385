// 来水过程生成：种子随机，同一关卡种子逐位可复现
import { deriveRng, gaussian, range } from './rng';
import type { InflowSeriesConfig, LevelConfig } from './types';

/** 生成单站天然来水序列（m³/s），长度 horizonSteps */
export function generateInflowSeries(cfg: InflowSeriesConfig, horizon: number, seed: string, stationId: string): number[] {
  const rng = deriveRng(seed, `inflow:${stationId}`);
  const out: number[] = new Array(horizon);

  // 1) 确定性地挑出暴雨起点（避免集中在开头/结尾）
  const storms: { start: number; duration: number; peak: number }[] = [];
  const margin = Math.max(4, Math.floor(horizon * 0.05));
  for (let i = 0; i < cfg.stormCount; i++) {
    const start = Math.floor(range(rng, margin, horizon - margin));
    const duration = Math.floor(range(rng, cfg.stormDurationRange[0], cfg.stormDurationRange[1] + 1));
    const peak = cfg.baseFlow * range(rng, cfg.stormPeakMultiplier[0], cfg.stormPeakMultiplier[1]);
    storms.push({ start, duration, peak });
  }

  for (let t = 0; t < horizon; t++) {
    // 基流 + 季节过程 + 自相关-ish 噪声
    const seasonal =
      cfg.seasonalAmplitude * Math.sin((2 * Math.PI * t) / Math.max(1, cfg.seasonalPeriodSteps));
    const noise = gaussian(rng, 0, cfg.baseFlow * cfg.noiseRatio);
    let q = cfg.baseFlow + seasonal + noise;

    // 暴雨脉冲（三角形洪水过程线：涨水快、退水慢）
    for (const s of storms) {
      const d = t - s.start;
      if (d >= 0 && d < s.duration) {
        const rising = Math.max(1, Math.floor(s.duration * 0.35));
        const shape = d < rising ? d / rising : 1 - (d - rising) / Math.max(1, s.duration - rising);
        q += s.peak * Math.max(0, shape);
      }
    }
    out[t] = Math.max(0, q);
  }
  return out;
}

/** 生成全关卡所有站的天然来水 */
export function generateAllInflows(level: LevelConfig): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const st of level.stations) {
    const cfg = level.inflow[st.id];
    result[st.id] = cfg
      ? generateInflowSeries(cfg, level.horizonSteps, level.seed, st.id)
      : new Array(level.horizonSteps).fill(0);
  }
  return result;
}
