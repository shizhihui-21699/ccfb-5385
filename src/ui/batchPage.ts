// 平衡模拟页：多策略 × 多种子批量跑，胜率与得分分布
import { SimulationEngine } from '../core/engine';
import { deriveBatchSeed, type BatchReport } from '../core/batch';
import { STRATEGIES } from '../core/strategies';
import { app } from '../state/app';
import { fmt, h, toast } from './dom';
import type { LevelConfig } from '../core/types';

export function renderBatch(): HTMLElement {
  const levels = app.allLevels();
  let selectedLevel: LevelConfig = levels[0];
  let seedCount = 120;
  let running = false;

  const wrap = h('div', { class: 'page' },
    h('div', { class: 'topbar' },
      h('button', { class: 'ghost', onClick: () => app.go('menu') }, '← 返回'),
      h('h2', { class: 'page-title' }, '平衡模拟'),
      h('div', { class: 'spacer' }),
    ),
    h('div', { class: 'page-sub' }, `内置 ${STRATEGIES.length} 种自动策略，对派生种子批量跑局（同基础种子确定性派生，结果可复现）。`),
    h('div', { class: 'card', style: { padding: '16px' } },
      h('div', { class: 'batch-controls' },
        h('label', {}, '关卡',
          h('select', { id: 'level-select' }, ...levels.map((l) => h('option', { value: l.id }, l.name))),
        ),
        h('label', {}, `种子数量（局数=策略数×种子数）`,
          h('input', { id: 'seed-count', type: 'number', min: '8', max: '600', value: String(seedCount), style: { width: '110px' } }),
        ),
        h('button', { class: 'primary', id: 'run-btn' }, '开始批量模拟'),
        h('span', { id: 'progress-text', class: 'muted' }, ''),
      ),
    ),
    h('div', { id: 'report-slot', style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' } }),
  );

  const select = wrap.querySelector('#level-select') as HTMLSelectElement;
  const seedInput = wrap.querySelector('#seed-count') as HTMLInputElement;
  const runBtn = wrap.querySelector('#run-btn') as HTMLButtonElement;
  const progressText = wrap.querySelector('#progress-text') as HTMLElement;
  const slot = wrap.querySelector('#report-slot') as HTMLElement;
  select.value = selectedLevel.id;

  runBtn.addEventListener('click', async () => {
    if (running) return;
    selectedLevel = app.findLevel(select.value) ?? levels[0];
    seedCount = clampInt(Number(seedInput.value), 8, 600);
    seedInput.value = String(seedCount);
    running = true;
    runBtn.disabled = true;
    slot.replaceChildren();
    const totalRuns = STRATEGIES.length * seedCount;
    progressText.textContent = `准备运行 ${totalRuns} 局…`;
    await nextFrame();
    const t0 = performance.now();
    // 分批让出主线程，避免几百局时页面卡死
    const report = await runBatchAsync(selectedLevel, seedCount, (done) => {
      progressText.textContent = `运行中 ${done}/${totalRuns} 局…`;
    });
    const ms = performance.now() - t0;
    progressText.textContent = `完成 ${totalRuns} 局，耗时 ${(ms / 1000).toFixed(2)}s（基础种子 ${selectedLevel.seed}）`;
    renderReport(slot, report);
    running = false;
    runBtn.disabled = false;
    toast('批量模拟完成');
  });

  return wrap;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function nextFrame(): Promise<void> {
  // 用 setTimeout 而非 rAF 分片：真实浏览器与 headless 虚拟时钟下都能稳定让出主线程
  return new Promise((r) => setTimeout(r, 0));
}

/** 分块异步跑批，复用核心引擎与确定性种子派生，按种子切片让出事件循环 */
async function runBatchAsync(level: LevelConfig, seedCount: number, onProgress: (done: number) => void): Promise<BatchReport> {
  const rows: BatchReport['rows'] = [];
  for (let i = 0; i < seedCount; i++) {
    const seed = deriveBatchSeed(level.seed, i);
    const variant: LevelConfig = { ...level, seed };
    for (const st of STRATEGIES) {
      const engine = new SimulationEngine(variant);
      while (engine.currentStep < variant.horizonSteps) engine.step(st.fn(engine.view(), variant));
      const res = engine.result();
      rows.push({
        seed, strategyId: st.id, strategyName: st.name,
        score: res.summary.finalScore, stars: res.summary.stars, failed: res.summary.failed,
        supplyReliability: res.summary.supplyReliability, energyMwh: res.summary.totalEnergyMwh,
        spillM3: res.summary.totalSpillM3, conservationError: res.summary.conservationError, steps: res.summary.steps,
      });
    }
    if (i % 8 === 7) { onProgress((i + 1) * STRATEGIES.length); await nextFrame(); }
  }
  onProgress(rows.length);
  return assembleReport(level.id, seedCount, rows);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function assembleReport(levelId: string, seedCount: number, rows: BatchReport['rows']): BatchReport {
  const stats = STRATEGIES.map((st) => {
    const mine = rows.filter((r) => r.strategyId === st.id);
    const scores = mine.map((r) => r.score).sort((a, b) => a - b);
    const lo = scores[0] ?? 0;
    const hi = scores[scores.length - 1] ?? 0;
    const width = hi > lo ? (hi - lo) / 8 : 1;
    const distribution = Array.from({ length: 8 }, (_, b) => ({
      label: `${Math.round(lo + b * width)}~${Math.round(lo + (b + 1) * width)}`,
      count: 0,
    }));
    for (const sc of scores) {
      let idx = Math.floor((sc - lo) / width);
      idx = Math.max(0, Math.min(7, idx));
      distribution[idx].count++;
    }
    return {
      strategyId: st.id,
      strategyName: st.name,
      runs: mine.length,
      winRate: mine.filter((r) => r.stars >= 1).length / Math.max(1, mine.length),
      threeStarRate: mine.filter((r) => r.stars >= 3).length / Math.max(1, mine.length),
      failureRate: mine.filter((r) => r.failed).length / Math.max(1, mine.length),
      avgScore: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length),
      minScore: lo, maxScore: hi, medianScore: percentile(scores, 0.5),
      avgReliability: mine.reduce((a, r) => a + r.supplyReliability, 0) / Math.max(1, mine.length),
      avgConservationError: mine.reduce((a, r) => a + r.conservationError, 0) / Math.max(1, mine.length),
      distribution,
    };
  });
  return { levelId, seedCount, rows, stats };
}

function renderReport(slot: HTMLElement, report: BatchReport): void {
  slot.replaceChildren();
  // 汇总表
  const table = h('div', { class: 'card', style: { padding: '6px 14px 14px' } },
    h('h3', { style: { margin: '12px 4px' } }, '策略胜率汇总'),
    h('table', { class: 'report' },
      h('thead', {}, h('tr', {},
        h('th', {}, '策略'), h('th', {}, '胜率(≥1星)'), h('th', {}, '三星率'), h('th', {}, '失败率'),
        h('th', {}, '平均分'), h('th', {}, '中位数'), h('th', {}, '最低'), h('th', {}, '最高'),
        h('th', {}, '平均保证率'), h('th', {}, '守恒误差'),
      )),
      h('tbody', {}, ...report.stats.map((s) => h('tr', {},
        h('td', {}, s.strategyName),
        pctCell(s.winRate, s.winRate >= 0.7 ? 'good' : s.winRate >= 0.4 ? 'warn' : 'danger'),
        pctCell(s.threeStarRate),
        pctCell(s.failureRate, s.failureRate > 0.1 ? 'danger' : ''),
        h('td', { class: 'mono' }, fmt(s.avgScore)),
        h('td', { class: 'mono' }, fmt(s.medianScore)),
        h('td', { class: 'mono' }, fmt(s.minScore)),
        h('td', { class: 'mono' }, fmt(s.maxScore)),
        h('td', { class: 'mono' }, `${(s.avgReliability * 100).toFixed(0)}%`),
        h('td', { class: 'mono faint' }, s.avgConservationError.toExponential(1)),
      ))),
    ),
  );
  slot.append(table);

  // 得分分布
  const histCard = h('div', { class: 'card', style: { padding: '14px 18px' } },
    h('h3', { style: { margin: '4px 0 12px' } }, '得分分布（每策略 8 个分位桶）'),
  );
  const maxCount = Math.max(1, ...report.stats.flatMap((s) => s.distribution.map((d) => d.count)));
  for (const s of report.stats) {
    histCard.append(
      h('div', { style: { marginBottom: '12px' } },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, s.strategyName),
        h('div', { class: 'hist-track' },
          ...s.distribution.map((d) => h('div', {
            class: 'hist-seg',
            style: { width: `${(d.count / maxCount) * 100}%`, minWidth: d.count ? '18px' : '0', opacity: String(0.45 + 0.55 * (d.count / maxCount)) },
            title: `${d.label}: ${d.count} 局`,
          }, d.count ? String(d.count) : '')),
        ),
        h('div', { class: 'faint', style: { fontSize: '11px', marginTop: '3px' } },
          s.distribution.map((d) => d.label).join('  →  ')),
      ),
    );
  }
  slot.append(histCard);
}

function pctCell(v: number, cls = ''): HTMLElement {
  return h('td', { class: 'mono ' + cls }, `${(v * 100).toFixed(0)}%`);
}
