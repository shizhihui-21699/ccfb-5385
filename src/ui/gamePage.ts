// 调度主界面
import { SimulationEngine } from '../core/engine';
import { clamp } from '../core/interp';
import { fmt, fmtVolume, h, toast, download } from './dom';
import { RiverView } from './canvas/riverView';
import { HydroChart, SERIES_INFLOW, SERIES_LEVEL, SERIES_RELEASE, SERIES_SCORE } from './canvas/hydroChart';
import { app, type GameLaunch } from '../state/app';
import { GameSession } from '../state/session';
import { buildReplay, saveGame } from '../persistence/storage';
import type { GameEvent, StationAction, StepAction } from '../core/types';

export function renderGame(launch: GameLaunch): HTMLElement {
  const session = new GameSession(launch.level, {
    resumeActions: launch.resumeActions,
    replayActions: launch.replay?.actions,
  });
  const level = launch.level;

  let selectedId = level.stations[0].id;
  // 各站待生效操作（草稿）
  const drafts: Record<string, StationAction> = Object.fromEntries(
    level.stations.map((s) => [s.id, { gateOpening: 0, activeUnits: Math.max(1, s.plant.unitCount - 1) }]),
  );
  let autoTimer: ReturnType<typeof setInterval> | null = null;
  let chartSeriesStation = selectedId;

  const wrap = h('div', { class: 'page' },
    h('div', { class: 'game-layout' },
      h('div', { class: 'game-head card', id: 'game-head' }),
      h('div', { class: 'canvas-wrap card', id: 'canvas-wrap' },
        h('canvas', { id: 'river-canvas' }),
        h('div', { id: 'event-banner-slot' }),
      ),
      h('div', { class: 'side-panel card', id: 'side-panel' }),
      h('div', { class: 'timeline-wrap card' },
        h('canvas', { id: 'hydro-canvas', style: { width: '100%', height: '150px', display: 'block' } }),
      ),
    ),
  );

  const headEl = wrap.querySelector('#game-head') as HTMLElement;
  const canvasWrap = wrap.querySelector('#canvas-wrap') as HTMLElement;
  const sideEl = wrap.querySelector('#side-panel') as HTMLElement;
  const bannerSlot = wrap.querySelector('#event-banner-slot') as HTMLElement;
  const riverCanvas = wrap.querySelector('#river-canvas') as HTMLCanvasElement;
  const hydroCanvas = wrap.querySelector('#hydro-canvas') as HTMLCanvasElement;

  const river = new RiverView(riverCanvas, level);
  const chart = new HydroChart(hydroCanvas);
  river.setClickHandler((id) => { selectedId = id; chartSeriesStation = id; refresh(); });
  chart.setSeekHandler((step) => {
    if (!session.isReplay) toast('仅回放模式支持拖动定位');
  });

  function stopAuto(): void {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }
  wrap.addEventListener('remove', stopAuto);

  function doStep(): void {
    if (session.finished) return;
    if (session.isReplay) {
      session.replayNext();
    } else {
      const action: StepAction = {};
      for (const s of level.stations) action[s.id] = { ...drafts[s.id] };
      session.applyStep(action);
    }
    if (session.finished) {
      stopAuto();
      onFinish();
    }
    refresh();
  }

  function onFinish(): void {
    const res = session.result();
    if (!session.isReplay) {
      app.recordBest(level.id, res.summary.stars, res.summary.finalScore);
      showResultModal(session, launch, () => refresh());
    } else {
      showReplayEndModal(session);
    }
  }

  function refresh(): void {
    const view = session.view;
    const active = view.activeEvents;
    renderHead(headEl, session);
    renderBanner(bannerSlot, active);
    renderSide(sideEl, session, selectedId, drafts, (id) => { selectedId = id; chartSeriesStation = id; refresh(); }, () => refresh(), doStep, stopAuto, () => { autoTimer = setInterval(doStep, 700); }, launch);
    river.draw(view, session.records, selectedId, active);
    chart.setData(
      session.records,
      level.horizonSteps,
      session.step,
      [
        { ...SERIES_INFLOW, stationId: chartSeriesStation },
        { ...SERIES_RELEASE, stationId: chartSeriesStation },
        { ...SERIES_LEVEL, stationId: chartSeriesStation },
        SERIES_SCORE,
      ],
    );
  }

  // 键盘：空格推进、1-4 选站
  function keyHandler(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'Space') { e.preventDefault(); doStep(); }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= level.stations.length) {
      selectedId = level.stations[n - 1].id;
      chartSeriesStation = selectedId;
      refresh();
    }
  }
  document.addEventListener('keydown', keyHandler);
  const obs = new MutationObserver(() => {
    if (!document.body.contains(wrap)) {
      document.removeEventListener('keydown', keyHandler);
      stopAuto();
      river.dispose();
      chart.dispose();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // 续档/回放进入时若已到终点，直接弹结算
  refresh();
  if (session.finished) setTimeout(() => (session.isReplay ? showReplayEndModal(session) : showResultModal(session, launch, () => refresh())), 60);

  return wrap;
}

function renderHead(el: HTMLElement, session: GameSession): void {
  const view = session.view;
  const rec = session.records.at(-1);
  const breakdown = rec?.scoreDelta;
  el.replaceChildren(
    h('button', { class: 'ghost small', onClick: () => app.go('levels') }, '← 退出'),
    chip('当前步', `${session.step}/${session.horizon}`),
    chip('累计得分', fmt(view.totalScore), view.totalScore < 0 ? 'danger' : 'good'),
    chip('总功率', `${fmt(view.stations.reduce((a, s) => a + s.powerMw, 0))} MW`),
    chip('下游供保', `${(session.records.length ? (session.records.reduce((a, r) => a + r.supplyRatio, 0) / session.records.length * 100) : 100).toFixed(0)}%`),
    chip('守恒误差', session.records.length ? (session.engine.result().summary.conservationError * 1e9).toFixed(2) + 'e-9' : '0'),
    h('div', { class: 'spacer' }),
    session.isReplay ? h('span', { class: 'tag', style: { borderColor: 'var(--accent)', color: 'var(--accent)' } }, '回放模式') : h('span', { class: 'tag' }, '实时调度'),
  );
  if (breakdown) {
    el.append(h('span', { class: 'faint mono', style: { fontSize: '11px' } },
      `本步 发电${fmt(breakdown.energy)} 防洪${fmt(breakdown.flood)} 缺水${fmt(breakdown.deficit)}`));
  }
}

function chip(k: string, v: string, cls = ''): HTMLElement {
  return h('div', { class: 'stat-chip' },
    h('span', { class: 'k' }, k),
    h('span', { class: 'v ' + cls }, v),
  );
}

function renderBanner(el: HTMLElement, events: GameEvent[]): void {
  el.replaceChildren();
  if (!events.length) return;
  for (const ev of events.slice(0, 2)) {
    const isWarn = ev.type === 'demand_shift';
    el.append(h('div', { class: 'event-banner' + (isWarn ? ' warn' : '') },
      h('strong', {}, `⚠ ${ev.title}　`), ev.detail));
  }
}

function renderSide(
  el: HTMLElement,
  session: GameSession,
  selectedId: string,
  drafts: Record<string, StationAction>,
  select: (id: string) => void,
  refresh: () => void,
  doStep: () => void,
  stopAuto: () => void,
  startAuto: () => void,
  launch: GameLaunch,
): void {
  const level = session.level;
  const view = session.view;
  const sv = view.stations.find((s) => s.cfg.id === selectedId)!;
  const cfg = sv.cfg;
  const draft = drafts[selectedId];
  const rec = session.records.at(-1)?.stations.find((s) => s.stationId === selectedId);
  const forecast = view.forecastAt(selectedId, 3);
  const overFlood = sv.level > cfg.floodLimitLevel;
  const deadRatio = clamp((sv.level - cfg.deadLevel) / (cfg.normalLevel - cfg.deadLevel), 0, 1.2);

  const tabs = h('div', { class: 'station-select' },
    ...level.stations.map((s) => {
      const stView = view.stations.find((v) => v.cfg.id === s.id)!;
      const alert = stView.level > s.floodLimitLevel;
      return h('div', {
        class: 'station-tab' + (s.id === selectedId ? ' active' : '') + (alert ? ' alert' : ''),
        onClick: () => select(s.id),
      }, s.id, h('div', { style: { fontSize: '10px', fontWeight: 400 } }, stView.level.toFixed(1) + 'm'));
    }),
  );

  const metrics = h('div', {},
    metric('当前水位', `${sv.level.toFixed(2)} m`, overFlood ? 'danger' : ''),
    metric('当前库容', fmtVolume(sv.storage)),
    metric('死/汛限/坝顶', `${cfg.deadLevel}/${cfg.floodLimitLevel}/${cfg.damTopLevel} m`),
    metric('入库流量', `${fmt(sv.inflow)} m³/s`),
    metric('发电流量', `${fmt(rec?.turbineRelease ?? 0)} m³/s`),
    metric('泄洪流量', `${fmt(rec?.spillRelease ?? 0)} m³/s`),
    metric('发电水头', `${sv.head.toFixed(1)} m`),
    metric('实时功率', `${fmt(sv.powerMw)} MW`),
    metric('可用机组', `${sv.effectiveUnits}/${cfg.plant.unitCount} 台`),
    metric('未来3步预报', forecast.map((q) => Math.round(q)).join(' / ') + ' m³/s'),
  );

  const gateSlider = h('input', {
    type: 'range', min: '0', max: '100', value: String(Math.round(draft.gateOpening * 100)),
    disabled: session.isReplay ? '' : null,
    oninput: (e: Event) => { draft.gateOpening = Number((e.target as HTMLInputElement).value) / 100; gateVal.textContent = `${Math.round(draft.gateOpening * 100)}%`; },
  });
  const gateVal = h('strong', { class: 'mono' }, `${Math.round(draft.gateOpening * 100)}%`);

  const unitVal = h('span', { class: 'val mono' }, String(draft.activeUnits));
  const unitStepper = h('div', { class: 'stepper' },
    h('button', { disabled: session.isReplay ? '' : null, onClick: () => { draft.activeUnits = Math.max(0, draft.activeUnits - 1); unitVal.textContent = String(draft.activeUnits); } }, '−'),
    unitVal,
    h('button', { disabled: session.isReplay ? '' : null, onClick: () => { draft.activeUnits = Math.min(sv.effectiveUnits, draft.activeUnits + 1); unitVal.textContent = String(draft.activeUnits); } }, '＋'),
  );

  const controls = h('div', { class: 'ctrl-block' },
    h('div', { class: 'ctrl-head' }, h('strong', {}, '闸门开度'), gateVal),
    gateSlider,
    h('div', { class: 'ctrl-head' }, h('strong', {}, '开机台数'), h('span', { class: 'faint' }, `上限 ${sv.effectiveUnits}`)),
    unitStepper,
  );

  const presets = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
    h('button', { class: 'small', disabled: session.isReplay ? '' : null, onClick: () => { draft.gateOpening = 0; gateSlider.value = '0'; gateVal.textContent = '0%'; } }, '关闸蓄水'),
    h('button', { class: 'small', disabled: session.isReplay ? '' : null, onClick: () => { draft.gateOpening = 1; gateSlider.value = '100'; gateVal.textContent = '100%'; } }, '全开泄洪'),
    h('button', { class: 'small', disabled: session.isReplay ? '' : null, onClick: () => { draft.activeUnits = sv.effectiveUnits; unitVal.textContent = String(draft.activeUnits); } }, '全部开机'),
    h('button', { class: 'small', disabled: session.isReplay ? '' : null, onClick: () => { draft.activeUnits = 0; unitVal.textContent = '0'; } }, '停机'),
  );

  const actionBtns = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
    session.isReplay
      ? h('button', { class: 'primary', onClick: doStep }, `▶ 播放下一步（${session.step}/${session.horizon}）`)
      : h('button', { class: 'primary', disabled: session.finished ? '' : null, onClick: doStep }, `▶ 推进一步（空格）`),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'small', style: { flex: 1 }, disabled: session.isReplay || session.finished ? '' : null, onClick: startAuto }, '自动连走'),
      h('button', { class: 'small', style: { flex: 1 }, onClick: stopAuto }, '暂停'),
    ),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'small ghost', style: { flex: 1 }, disabled: session.isReplay ? '' : null, onClick: () => quickSave(session, launch) }, '快速存档'),
      h('button', { class: 'small ghost', style: { flex: 1 }, disabled: session.isReplay || !session.finished ? '' : null, onClick: () => exportReplay(session) }, '导出录像'),
    ),
  );

  el.replaceChildren(
    h('div', {},
      h('div', { style: { fontWeight: 700, fontSize: '15px', marginBottom: '8px' } }, cfg.name),
      h('div', { class: 'progress' }, h('div', { style: { width: `${clamp(deadRatio, 0, 1) * 100}%`, background: overFlood ? 'var(--danger)' : undefined } })),
    ),
    tabs,
    h('div', { class: 'form-section' }, metrics),
    h('div', { class: 'form-section' }, controls, presets),
    actionBtns,
    h('div', { class: 'faint', style: { fontSize: '11px', lineHeight: 1.6 } },
      '发电优先占用出库流量，闸门承担剩余泄量；水位贴死水位时出库自动受限。操作在点击“推进一步”后对四库同时生效。'),
  );
}

function metric(k: string, v: string, cls = ''): HTMLElement {
  return h('div', { class: 'metric-row' }, h('span', { class: 'muted' }, k), h('span', { class: 'v ' + cls }, v));
}

function quickSave(session: GameSession, launch: GameLaunch): void {
  const name = `${session.level.name}-${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  saveGame({
    name,
    level: session.level,
    actions: session.actions,
    currentStep: session.step,
    score: session.view.totalScore,
    finished: session.finished,
  });
  toast(`已存档：${name}`);
}

function exportReplay(session: GameSession): void {
  const res = session.result();
  const replay = buildReplay(session.level, session.actions, {
    finalScore: res.summary.finalScore,
    stars: res.summary.stars,
    steps: res.summary.steps,
    failed: res.summary.failed,
  });
  download(`replay-${session.level.id}-${session.step}.json`, JSON.stringify(replay, null, 2));
  toast('录像已导出');
}

function showResultModal(session: GameSession, launch: GameLaunch, close: () => void): void {
  const res = session.result();
  const s = res.summary;
  const mask = h('div', { class: 'modal-mask' });
  const modal = h('div', { class: 'modal card' },
    h('h2', {}, s.failed ? '💥 调度失败' : '🎉 调度完成'),
    s.failed ? h('div', { class: 'danger' }, s.failureReason ?? '发生漫坝') : h('div', { class: 'muted' }, `完成全部 ${s.steps} 步调度`),
    h('div', { style: { textAlign: 'center', margin: '8px 0' } },
      h('div', { class: 'score-big' }, fmt(s.finalScore)),
      h('div', { class: 'stars', style: { fontSize: '28px' } }, '★'.repeat(s.stars) + '☆'.repeat(3 - s.stars)),
    ),
    resultRows(s),
    h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' } },
      h('button', { onClick: () => exportReplay(session) }, '导出录像'),
      h('button', { onClick: () => { mask.remove(); quickSave(session, launch); } }, '存档'),
      h('button', { class: 'ghost', onClick: () => { mask.remove(); app.go('levels'); } }, '返回选关'),
      h('button', { class: 'primary', onClick: () => { mask.remove(); app.go('game', { level: structuredClone(session.level), source: 'level' }); } }, '再来一局'),
    ),
  );
  mask.append(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) { mask.remove(); close(); } });
  document.body.append(mask);
}

function showReplayEndModal(session: GameSession): void {
  const s = session.result().summary;
  const mask = h('div', { class: 'modal-mask' });
  mask.append(h('div', { class: 'modal card' },
    h('h2', {}, '回放结束'),
    h('div', { class: 'muted' }, `共 ${s.steps} 步，最终 ${fmt(s.finalScore)} 分，${'★'.repeat(s.stars)}${'☆'.repeat(3 - s.stars)}`),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px' } },
      h('button', { class: 'ghost', onClick: () => app.go('menu') }, '回主菜单'),
      h('button', { class: 'primary', onClick: () => mask.remove() }, '关闭'),
    ),
  ));
  document.body.append(mask);
}

function resultRows(s: ReturnType<SimulationEngine['result']>['summary']): HTMLElement {
  const rows: [string, string][] = [
    ['总发电量', `${fmt(s.totalEnergyMwh)} MWh`],
    ['累计弃水', fmtVolume(s.totalSpillM3)],
    ['供水保证率', `${(s.supplyReliability * 100).toFixed(1)}%`],
    ['守恒相对误差', s.conservationError.toExponential(2)],
  ];
  return h('div', { class: 'form-section' }, ...rows.map(([k, v]) => metric(k, v)));
}
