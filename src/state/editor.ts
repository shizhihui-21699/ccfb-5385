// 编辑器用关卡工厂与编辑期工具
import { CURRENT_CONFIG_VERSION, buildReaches, buildStations } from '../data/defaultLevels';
import { validateLevel } from '../persistence/migration';
import type { LevelConfig } from '../core/types';

export function newBlankLevel(seed = 'CUSTOM-' + Math.floor(Math.random() * 9000 + 1000)): LevelConfig {
  const stations = buildStations(0.55);
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    id: 'custom_' + Date.now().toString(36),
    name: '自定义关卡',
    description: '在编辑器中调整河道、来水与目标。',
    horizonSteps: 96,
    dtSeconds: 21600,
    seed,
    stations,
    reaches: buildReaches(),
    inflow: Object.fromEntries(stations.map((s) => [
      s.id,
      {
        baseFlow: 200, seasonalAmplitude: 50, seasonalPeriodSteps: 48, noiseRatio: 0.08,
        stormCount: 3, stormPeakMultiplier: [2, 4] as [number, number], stormDurationRange: [4, 9] as [number, number],
      },
    ])),
    demand: { segments: [{ startStep: 0, flow: 320 }] },
    events: {
      stormForecastBias: { enabled: true, count: 2, magnitude: 0.3, durationSteps: 6 },
      maintenance: { enabled: true, count: 2, durationSteps: 8, unitsDown: 1 },
      demandShift: { enabled: true, count: 2, durationSteps: 10, magnitude: 0.4 },
    },
    scoring: {
      pointsPerMwh: 0.002, floodPenaltyPerMeterStep: 8, deficitPenaltyPerCms: 0.3,
      bandRewardPerStep: 4, endStorageRewardPerM3: 1e-8, spillPenaltyPerM3: 5e-9,
      damFailurePenalty: 3000, starThresholds: { one: 800, two: 1500, three: 2400 },
    },
  };
}

export function assertEditable(level: LevelConfig): string | null {
  try {
    validateLevel(level);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
