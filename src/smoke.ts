// 浏览器端冒烟测试：由 smoke.html 加载，自动遍历各页面并把结果写到 window.__SMOKE__
import { SimulationEngine } from './core/engine';
import { runBatch } from './core/batch';
import { checkAllStrategiesDeterminism } from './core/determinism';
import { buildDefaultLevels } from './data/defaultLevels';
import { app } from './state/app';
import { GameSession } from './state/session';
import { renderMenu } from './ui/menuPage';
import { renderLevels } from './ui/levelsPage';
import { renderGame } from './ui/gamePage';
import { renderEditor } from './ui/editorPage';
import { renderBatch } from './ui/batchPage';
import { renderSaves } from './ui/savesPage';

// 冒烟页独立挂载路由（正式应用在 main.ts 中挂载）
const rootEl = document.getElementById('app')!;
app.sub(() => {
  switch (app.screen) {
    case 'menu': rootEl.replaceChildren(renderMenu()); break;
    case 'levels': rootEl.replaceChildren(renderLevels()); break;
    case 'game': rootEl.replaceChildren(renderGame(app.launch!)); break;
    case 'editor': rootEl.replaceChildren(renderEditor(app.launch?.level)); break;
    case 'batch': rootEl.replaceChildren(renderBatch()); break;
    case 'saves': rootEl.replaceChildren(renderSaves()); break;
  }
});
app.go('menu');

interface SmokeResult { ok: boolean; checks: string[]; errors: string[] }
const result: SmokeResult = { ok: true, checks: [], errors: [] };
function check(name: string, cond: boolean, extra = ''): void {
  result.checks.push(`${cond ? '✓' : '✗'} ${name} ${extra}`);
  if (!cond) { result.ok = false; result.errors.push(name); }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

async function main(): Promise<void> {
  // 1. 引擎层
  const level = buildDefaultLevels()[0];
  const det = checkAllStrategiesDeterminism(level);
  check('四策略确定性', det.every((d) => d.ok));
  const session = new GameSession(level);
  let guard = 0;
  while (!session.finished && guard++ < 500) {
    const v = session.view;
    const action: Record<string, { gateOpening: number; activeUnits: number }> = {};
    for (const s of v.stations) action[s.cfg.id] = { gateOpening: 0.3, activeUnits: Math.max(1, s.effectiveUnits - 1) };
    session.applyStep(action);
  }
  const res = session.result();
  check('对局跑完全程', session.step === level.horizonSteps, `(${session.step}步)`);
  check('守恒误差<1e-9', res.summary.conservationError < 1e-9, res.summary.conservationError.toExponential(2));
  check('录像操作长度=步数', session.actions.length === level.horizonSteps);

  // 2. 批量模拟（小批量）
  const report = runBatch(level, 6);
  check('批量行数正确', report.rows.length === 6 * 4, `(${report.rows.length})`);
  check('批量守恒', report.stats.every((s) => s.avgConservationError < 1e-9));

  // 3. UI 路由遍历
  const screens = ['levels', 'editor', 'batch', 'saves', 'menu', 'levels'] as const;
  for (const sc of screens) {
    app.go(sc);
    await tick();
    check(`路由渲染 ${sc}`, document.getElementById('app')?.children.length === 1);
  }

  // 4. 进对局页，验证 Canvas 与推进
  app.go('game', { level: structuredClone(level), source: 'level' });
  await tick();
  await tick();
  const riverCanvas = document.querySelector('#river-canvas') as HTMLCanvasElement;
  const hydroCanvas = document.querySelector('#hydro-canvas') as HTMLCanvasElement;
  check('河道 Canvas 已挂载且有尺寸', !!riverCanvas && riverCanvas.width > 0, `${riverCanvas?.width}x${riverCanvas?.height}`);
  check('过程线 Canvas 已挂载', !!hydroCanvas && hydroCanvas.width > 0);
  const stepBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('推进一步')) as HTMLButtonElement;
  check('推进按钮存在', !!stepBtn);
  stepBtn?.click();
  await tick();
  const headText = document.querySelector('#game-head')?.textContent ?? '';
  check('点击推进后头信息更新', headText.includes('1/'), headText.match(/\d+\/\d+/)?.[0] ?? '');
  // 切站
  const tabs = document.querySelectorAll('.station-tab');
  check('四个站切换标签', tabs.length === 4);
  (tabs[2] as HTMLElement).click();
  await tick();
  check('切站后 C 高亮', !!document.querySelector('.station-tab.active')?.textContent?.startsWith('C'));

  // 5. 编辑器
  app.go('editor');
  await tick();
  check('编辑器表单渲染', document.querySelectorAll('.form-section').length >= 5, `(${document.querySelectorAll('.form-section').length}段)`);
  check('编辑器预览 Canvas', !!document.querySelector('#preview-slot canvas'));

  // 6. 存档写入与读取（localStorage）
  app.go('game', { level: structuredClone(level), source: 'level' });
  await tick();
  const saveBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('快速存档')) as HTMLButtonElement;
  saveBtn?.click();
  await tick();
  app.go('saves');
  await tick();
  check('存档列表出现记录', document.querySelectorAll('.save-row').length >= 1, `(${document.querySelectorAll('.save-row').length}条)`);

  // 7. 回放模式（喂入完整操作序列，结果必须与原局逐分一致）
  const replaySession = new GameSession(level, { replayActions: session.actions });
  let rg = 0;
  while (!replaySession.finished && rg++ < 500) replaySession.replayNext();
  check('回放可完整播放', replaySession.step === level.horizonSteps);
  check('回放结果与原局同分', Math.abs(replaySession.result().summary.finalScore - res.summary.finalScore) < 1e-6,
    `原局${res.summary.finalScore.toFixed(3)} vs 回放${replaySession.result().summary.finalScore.toFixed(3)}`);

  (window as unknown as Record<string, unknown>).__SMOKE__ = result;
  const pre = document.createElement('pre');
  pre.id = 'smoke-output';
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.prepend(pre);
}

window.addEventListener('error', (e) => {
  result.ok = false;
  result.errors.push('运行时异常: ' + e.message + ' @ ' + (e.filename ?? '') + ':' + (e.lineno ?? ''));
});

main().catch((e) => {
  result.ok = false;
  result.errors.push('冒烟脚本崩溃: ' + (e as Error).stack);
  (window as unknown as Record<string, unknown>).__SMOKE__ = result;
  const pre = document.createElement('pre');
  pre.id = 'smoke-output';
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.prepend(pre);
});
