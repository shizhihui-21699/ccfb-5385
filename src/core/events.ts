// 突发事件预生成：全部在开局前由种子确定，保证回放与批量模拟一致
import { deriveRng, pickIndexes, range } from './rng';
import type { GameEvent, LevelConfig } from './types';

export function generateEvents(level: LevelConfig): GameEvent[] {
  const rng = deriveRng(level.seed, 'events');
  const events: GameEvent[] = [];
  const h = level.horizonSteps;
  let nextId = 1;
  const margin = Math.max(3, Math.floor(h * 0.08));

  const pickSteps = (count: number): number[] => {
    const poolSize = h - 2 * margin;
    if (poolSize <= 0) return [];
    return pickIndexes(rng, poolSize, count).map((i) => i + margin);
  };

  // 1) 暴雨预报不准：预报相对实际出现偏差
  if (level.events.stormForecastBias.enabled) {
    const cfg = level.events.stormForecastBias;
    for (const start of pickSteps(cfg.count)) {
      const sign = rng() > 0.5 ? 1 : -1;
      const bias = sign * range(rng, cfg.magnitude * 0.5, cfg.magnitude);
      const end = Math.min(h - 1, start + cfg.durationSteps - 1);
      events.push({
        id: nextId++,
        type: 'storm_bias',
        startStep: start,
        endStep: end,
        biasRatio: bias,
        title: '暴雨预报偏差',
        detail: `气象部门预报来水${bias > 0 ? '偏大' : '偏小'} ${(Math.abs(bias) * 100).toFixed(0)}%，持续 ${cfg.durationSteps} 步`,
      });
    }
  }

  // 2) 机组检修：随机站点随机时段减少可用机组
  if (level.events.maintenance.enabled) {
    const cfg = level.events.maintenance;
    for (const start of pickSteps(cfg.count)) {
      const st = level.stations[Math.floor(rng() * level.stations.length)];
      const end = Math.min(h - 1, start + cfg.durationSteps - 1);
      events.push({
        id: nextId++,
        type: 'maintenance',
        stationId: st.id,
        startStep: start,
        endStep: end,
        unitsDown: cfg.unitsDown,
        title: `${st.name} 机组检修`,
        detail: `${cfg.unitsDown} 台机组停机检修，持续 ${cfg.durationSteps} 步，期间可用机组减少`,
      });
    }
  }

  // 3) 下游抽水需求变化
  if (level.events.demandShift.enabled) {
    const cfg = level.events.demandShift;
    for (const start of pickSteps(cfg.count)) {
      const sign = rng() > 0.4 ? 1 : -1; // 增需求的概率略高
      const delta = sign * range(rng, cfg.magnitude * 0.5, cfg.magnitude);
      const end = Math.min(h - 1, start + cfg.durationSteps - 1);
      events.push({
        id: nextId++,
        type: 'demand_shift',
        startStep: start,
        endStep: end,
        demandDelta: delta,
        title: '下游抽水需求变化',
        detail: `下游灌溉/供水抽水需求${delta > 0 ? '增加' : '减少'} ${(Math.abs(delta) * 100).toFixed(0)}%，持续 ${cfg.durationSteps} 步`,
      });
    }
  }

  return events.sort((a, b) => a.startStep - b.startStep);
}

/** 计算某步激活的事件 */
export function activeEventsAt(events: GameEvent[], step: number): GameEvent[] {
  return events.filter((e) => step >= e.startStep && step <= e.endStep);
}
