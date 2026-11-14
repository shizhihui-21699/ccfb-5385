// 引擎自测：守恒 / 确定性 / 时滞 / 事件 / 策略 / 批量，运行：npm test
import { runBatch } from '../src/core/batch';
import { checkAllStrategiesDeterminism, fingerprint } from '../src/core/determinism';
import { SimulationEngine, simulate } from '../src/core/engine';
import { buildDefaultLevels } from '../src/data/defaultLevels';
import { STRATEGIES } from '../src/core/strategies';
import type { LevelConfig, StepAction } from '../src/core/types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const level = buildDefaultLevels()[1]; // 汛期关卡，事件全有

console.log('— 1. 确定性：同种子同操作两次指纹一致 —');
{
  const actions: StepAction[] = [];
  const e0 = new SimulationEngine(level);
  while (!e0.isFinished) {
    const a = { A: { gateOpening: 0.4, activeUnits: 2 } };
    actions.push(a);
    e0.step(a);
  }
  const r1 = simulate(level, actions);
  const r2 = simulate(level, actions);
  assert(fingerprint(r1.records) === fingerprint(r2.records), '两次完整仿真记录指纹相同');
  assert(fingerprint(r1.events) === fingerprint(r2.events), '事件序列一致');
  const det = checkAllStrategiesDeterminism(level);
  assert(det.every((d) => d.ok), `四个自动策略各自复跑一致 (${det.length}/4)`);
}

console.log('— 2. 水量守恒 —');
{
  const e = new SimulationEngine(level);
  while (!e.isFinished) e.step({ A: { gateOpening: 0.5, activeUnits: 3 }, D: { gateOpening: 0.3, activeUnits: 1 } });
  const res = e.result();
  console.log(`    守恒相对误差 = ${(res.summary.conservationError * 1e9).toFixed(3)} ×1e-9`);
  assert(res.summary.conservationError < 1e-9, '累计水平衡相对误差 < 1e-9（浮点精度内守恒）');

  // 零操作：所有天然来水最终应等于出口总量 + 蓄水变化 + 期末河道槽蓄
  const e2 = new SimulationEngine(level);
  const dt = level.dtSeconds;
  const initial = level.stations.reduce((a, s) => a + s.initialStorage, 0);
  while (e2.currentStep < level.horizonSteps) e2.step({});
  const r2 = e2.result();
  const finalStorage = r2.records[r2.records.length - 1].stations.reduce((a, x) => a + x.storage, 0);
  const totalIn = Object.values(r2.naturalInflow).reduce((a, arr) => a + arr.reduce((x, q) => x + q * dt, 0), 0);
  const totalOut = r2.records.reduce((a, rec) => a + rec.outletFlow * dt, 0);
  const closingChannel = r2.records[r2.records.length - 1].systemWater - finalStorage;
  const err = Math.abs(initial + totalIn - finalStorage - totalOut - closingChannel) / totalIn;
  assert(err < 1e-9, `零操作全局闭合（天然来水 ${(totalIn / 1e8).toFixed(2)} 亿m³，闭合误差 ${(err * 1e9).toFixed(2)}e-9）`);
}

console.log('— 3. 河道时滞 —');
{
  // 单步脉冲：A 站只在第 3 步泄放，B 站应在 3+lag 步收到（用平稳关卡避免洪水干扰）
  const calmLevel = buildDefaultLevels()[0];
  const lag = calmLevel.reaches[0].lagSteps;
  const e = new SimulationEngine(calmLevel);
  const bInflow: number[] = [];
  const pulseStep = 3;
  while (e.currentStep < calmLevel.horizonSteps) {
    const t = e.currentStep;
    const act: StepAction = {};
    if (t === pulseStep) act.A = { gateOpening: 1, activeUnits: 0 };
    const rec = e.step(act);
    bInflow.push(rec.stations.find((s) => s.stationId === 'B')!.inflow);
  }
  // 只在脉冲后 0~lag+2 窗口内找增量峰值，避开后续天然洪水
  const baseAvg = bInflow.slice(0, pulseStep).reduce((a, b) => a + b, 0) / pulseStep;
  let peakIdx = -1;
  let peakVal = -Infinity;
  for (let i = pulseStep; i <= pulseStep + lag + 2 && i < bInflow.length; i++) {
    const d = bInflow[i] - baseAvg;
    if (d > peakVal) {
      peakVal = d;
      peakIdx = i;
    }
  }
  assert(peakIdx === pulseStep + lag, `A 第${pulseStep}步泄放，B 在第${peakIdx}步收到（预期 ${pulseStep + lag}）`);
}

console.log('— 4. 事件生成与触发 —');
{
  const e = new SimulationEngine(level);
  const types = new Set(e.events.map((x) => x.type));
  assert(types.has('storm_bias') && types.has('maintenance') && types.has('demand_shift'), '三类突发事件均已生成');
  let sawActive = false;
  while (!e.isFinished) {
    const v = e.view();
    if (v.activeEvents.length > 0) sawActive = true;
    e.step({});
  }
  assert(sawActive, '对局过程中至少触发一次事件');
  // 预报确实被偏差事件修改过
  const changed = level.stations.some((s) => {
    const f = e.forecast[s.id];
    const n = e.naturalInflow[s.id];
    return f.some((v, i) => Math.abs(v - n[i]) > 1e-6);
  });
  assert(changed, '暴雨偏差事件改变了预报序列（实际来水不变）');
}

console.log('— 5. 评分与星级 —');
{
  const res = new SimulationEngine(level).run([]);
  const sum = res.summary;
  assert(typeof sum.finalScore === 'number' && Number.isFinite(sum.finalScore), '总分有限数值');
  assert(sum.stars >= 0 && sum.stars <= 3, `星级在 0~3（得 ${sum.stars} 星，${Math.round(sum.finalScore)} 分）`);
  const stepSum = res.records.reduce((a, r) => a + r.scoreDelta.total, 0);
  assert(Math.abs(stepSum - sum.finalScore) < 1e-6, '逐步得分之和等于总分');
}

console.log('— 6. 漫坝判负 —');
{
  const brutal: LevelConfig = structuredClone(level);
  brutal.seed = 'DAM-TEST';
  brutal.horizonSteps = 40;
  // 极大来水 + 零操作
  for (const k of Object.keys(brutal.inflow)) {
    brutal.inflow[k].baseFlow = 5000;
    brutal.inflow[k].seasonalAmplitude = 0;
    brutal.inflow[k].stormCount = 0;
    brutal.inflow[k].noiseRatio = 0;
  }
  brutal.events = {
    stormForecastBias: { enabled: false, count: 0, magnitude: 0, durationSteps: 0 },
    maintenance: { enabled: false, count: 0, durationSteps: 0, unitsDown: 0 },
    demandShift: { enabled: false, count: 0, durationSteps: 0, magnitude: 0 },
  };
  const res = new SimulationEngine(brutal).run([]);
  assert(res.summary.failed === true, '极端来水零操作触发漫坝判负');
  assert(!!res.summary.failureReason, '给出失败原因');
}

console.log('— 7. 批量平衡模拟 —');
{
  const report = runBatch(level, 24);
  assert(report.rows.length === 24 * STRATEGIES.length, `批量行数 = 种子数×策略数 (${report.rows.length})`);
  assert(report.stats.length === STRATEGIES.length, '每个策略都有统计');
  for (const st of report.stats) {
    assert(st.avgConservationError < 1e-9, `${st.strategyName} 全部局次守恒（误差 ${(st.avgConservationError * 1e12).toFixed(1)}e-12）`);
    assert(st.distribution.reduce((a, b) => a + b.count, 0) === st.runs, `${st.strategyName} 得分分布桶计数等于局数`);
    console.log(`    ${st.strategyName}: 胜率 ${(st.winRate * 100).toFixed(0)}% 三星 ${(st.threeStarRate * 100).toFixed(0)}% 均分 ${Math.round(st.avgScore)} 中位数 ${Math.round(st.medianScore)}`);
  }
  // 不同派生种子产生不同结果
  const seeds = new Set(report.rows.map((r) => r.seed));
  assert(seeds.size === 24, '24 个派生种子互不相同');
}

console.log('— 8. 存档迁移（模拟 v1 老存档） —');
{
  const { migrateLevel } = await import('../src/persistence/migration');
  const v1 = structuredClone(level) as Partial<LevelConfig> & { configVersion: number };
  v1.configVersion = 1;
  delete (v1.scoring as ScoringStub).spillPenaltyPerM3;
  const migrated = migrateLevel(v1);
  assert(migrated.configVersion === 2, 'v1 配置升级到当前版本');
  assert(typeof migrated.scoring.spillPenaltyPerM3 === 'number', '补齐 v2 新增评分字段');
  const res = new SimulationEngine(migrated).run([]);
  assert(res.summary.steps > 0, '迁移后的老关卡可正常仿真');
}
interface ScoringStub { spillPenaltyPerM3?: number }

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} 项断言失败`);
  process.exit(1);
} else {
  console.log('✅ 全部引擎自测通过');
}
