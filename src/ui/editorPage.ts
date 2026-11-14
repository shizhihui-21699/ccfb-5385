// 关卡编辑器：河道/电站、来水、供水目标、突发事件、评分全可改；随时试玩与 JSON 导入导出
import { SimulationEngine } from '../core/engine';
import { download, h, toast, upload } from './dom';
import { app } from '../state/app';
import { newBlankLevel } from '../state/editor';
import { migrateLevel, validateLevel } from '../persistence/migration';
import type { LevelConfig, StationConfig } from '../core/types';

export function renderEditor(initial?: LevelConfig): HTMLElement {
  let level: LevelConfig = initial ? structuredClone(initial) : newBlankLevel();
  let selectedStation = level.stations[0]?.id ?? '';

  const wrap = h('div', { class: 'page' },
    h('div', { class: 'topbar' },
      h('button', { class: 'ghost', onClick: () => app.go('menu') }, '← 返回'),
      h('h2', { class: 'page-title' }, '关卡编辑器'),
      h('div', { class: 'spacer' }),
      h('button', { onClick: () => doImport() }, '导入 JSON'),
      h('button', { onClick: () => doExport() }, '导出 JSON'),
      h('button', { class: 'ghost', onClick: () => { if (confirm('放弃当前编辑，新建空白关卡？')) { level = newBlankLevel(); selectedStation = level.stations[0].id; rerender(); } } }, '新建空白'),
      h('button', { class: 'primary', onClick: () => saveAndStay() }, '保存关卡'),
      h('button', { class: 'primary', onClick: () => playtest() }, '▶ 直接试玩'),
    ),
    h('div', { class: 'page-sub' }, '所有数值实时绑定到关卡对象；试玩与正式对局共用同一套确定性引擎。'),
    h('div', { class: 'editor-layout' },
      h('div', { class: 'card', style: { padding: '14px', overflow: 'auto' }, id: 'preview-slot' }),
      h('div', { class: 'editor-form card', id: 'form-slot' }),
    ),
  );

  const previewSlot = wrap.querySelector('#preview-slot') as HTMLElement;
  const formSlot = wrap.querySelector('#form-slot') as HTMLElement;

  function rerender(): void {
    renderPreview(previewSlot, level, selectedStation, (id) => { selectedStation = id; renderForm(); });
    renderForm();
  }

  function renderForm(): void {
    const st = level.stations.find((s) => s.id === selectedStation) ?? level.stations[0];
    formSlot.replaceChildren();
    formSlot.append(
      section('基础信息',
        grid(
          field('关卡 ID', input(level.id, (v) => { level.id = v; })),
          field('关卡名称', input(level.name, (v) => { level.name = v; })),
          field('随机种子', input(level.seed, (v) => { level.seed = v; })),
          field('仿真步数', numInput(level.horizonSteps, (v) => { level.horizonSteps = Math.max(8, Math.round(v)); }, 8, 400)),
          field('每步秒数(默认21600=6h)', numInput(level.dtSeconds, (v) => { level.dtSeconds = Math.max(60, Math.round(v)); }, 60, 86400)),
          field('描述', textArea(level.description, (v) => { level.description = v; }), true),
        ),
      ),
      section('电站与河道',
        h('div', { class: 'station-select' },
          ...level.stations.map((s) => h('div', {
            class: 'station-tab' + (s.id === selectedStation ? ' active' : ''),
            onClick: () => { selectedStation = s.id; renderForm(); },
          }, s.id)),
        ),
        st ? stationFields(level, st, rerender) : h('div', { class: 'faint' }, '无电站'),
        reachesTable(level),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'small', onClick: () => addReach(level, rerender) }, '新增河道'),
        ),
      ),
      section('来水过程（按站）', inflowFields(level, st?.id ?? level.stations[0]?.id ?? '')),
      section('下游供水需求（分段）', demandFields(level, rerender)),
      section('突发事件', eventFields(level)),
      section('评分与星级阈值', scoringFields(level)),
      h('div', { style: { display: 'flex', gap: '10px' } },
        h('button', { class: 'primary', style: { flex: 1 }, onClick: () => saveAndStay() }, '保存关卡'),
        h('button', { class: 'primary', style: { flex: 1 }, onClick: () => playtest() }, '▶ 保存并试玩'),
      ),
    );
  }

  function saveAndStay(): void {
    const err = validateSafe(level);
    if (err) { alert('校验失败：' + err); return; }
    app.upsertCustomLevel(structuredClone(level));
    toast(`关卡「${level.name}」已保存`);
  }

  function playtest(): void {
    const err = validateSafe(level);
    if (err) { alert('校验失败，无法试玩：' + err); return; }
    app.upsertCustomLevel(structuredClone(level));
    app.go('game', { level: structuredClone(level), source: 'editor' });
  }

  async function doImport(): Promise<void> {
    try {
      const imported = migrateLevel(JSON.parse(await upload()));
      validateLevel(imported);
      level = imported;
      selectedStation = level.stations[0]?.id ?? '';
      rerender();
      toast('JSON 已载入编辑器');
    } catch (e) {
      alert('导入失败：' + (e as Error).message);
    }
  }
  function doExport(): void {
    const err = validateSafe(level);
    if (err) { alert('校验失败：' + err); return; }
    download(`${level.id}.json`, JSON.stringify(level, null, 2));
    toast('关卡 JSON 已导出');
  }

  rerender();
  return wrap;
}

function validateSafe(level: LevelConfig): string | null {
  try { validateLevel(level); return null; } catch (e) { return (e as Error).message; }
}

// ---------- 预览（用引擎跑一步看曲线/水位，轻量 Canvas 手绘） ----------
function renderPreview(slot: HTMLElement, level: LevelConfig, selectedId: string, select: (id: string) => void): void {
  slot.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '230px';
  slot.append(canvas);
  const err = validateSafe(level);
  if (err) {
    slot.append(h('div', { class: 'danger', style: { fontSize: '12px', marginTop: '8px' } }, '⚠ ' + err));
  }
  requestAnimationFrame(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    drawPreview(ctx, canvas.clientWidth, canvas.clientHeight, level, selectedId);
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let best = '';
      let bd = 60;
      level.stations.forEach((s, i) => {
        const cx = 60 + s.layout.x * (canvas.clientWidth - 120);
        const d = Math.abs(x - cx);
        if (d < bd) { bd = d; best = s.id; }
      });
      if (best) select(best);
    };
  });
}

function drawPreview(ctx: CanvasRenderingContext2D, w: number, h: number, level: LevelConfig, selectedId: string): void {
  ctx.fillStyle = '#0b1526';
  ctx.fillRect(0, 0, w, h);
  // 来水过程线
  const engine = new SimulationEngine(level);
  level.stations.forEach((s) => {
    const data = engine.naturalInflow[s.id] ?? [];
    const max = Math.max(1, ...data);
    const colors: Record<string, string> = { A: '#38bdf8', B: '#34d399', C: '#fbbf24', D: '#c084fc' };
    ctx.strokeStyle = colors[s.id] ?? '#888';
    ctx.lineWidth = s.id === selectedId ? 2.5 : 1.2;
    ctx.globalAlpha = s.id === selectedId ? 1 : 0.45;
    ctx.beginPath();
    data.forEach((q, i) => {
      const x = 40 + (i / Math.max(1, data.length - 1)) * (w - 80);
      const y = h - 40 - (q / max) * (h - 90);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors[s.id] ?? '#888';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${s.id} 峰值${Math.round(max)}`, 44, 18 + level.stations.indexOf(s) * 16);
  });
  // 库位示意
  level.stations.forEach((s) => {
    const cx = 60 + s.layout.x * (w - 120);
    const ratio = (s.initialStorage - s.levelStorage[0].storage) / (s.levelStorage.at(-1)!.storage - s.levelStorage[0].storage);
    ctx.fillStyle = s.id === selectedId ? '#38bdf8' : '#475569';
    ctx.fillRect(cx - 18, h - 30 - 30 * Math.max(0, Math.min(1, ratio)), 36, 30 * Math.max(0, Math.min(1, ratio)) + 6);
    ctx.fillStyle = '#e3ecf7';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.id, cx, h - 8);
    ctx.textAlign = 'left';
  });
}

// ---------- 表单片段 ----------
function section(title: string, ...children: Node[]): HTMLElement {
  return h('div', { class: 'form-section' }, h('h4', {}, title), ...children);
}
function field(label: string, input: HTMLElement, full = false): HTMLElement {
  return h('label', { class: full ? 'full' : '' }, label, input);
}
function grid(...children: Node[]): HTMLElement {
  return h('div', { class: 'form-grid' }, ...children);
}
function input(value: string, on: (v: string) => void): HTMLInputElement {
  const el = document.createElement('input');
  el.value = value;
  el.addEventListener('change', () => on(el.value));
  return el;
}
function numInput(value: number, on: (v: number) => void, min?: number, max?: number): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'number';
  if (min !== undefined) el.min = String(min);
  if (max !== undefined) el.max = String(max);
  el.value = String(value);
  el.addEventListener('change', () => on(Number(el.value)));
  return el;
}
function textArea(value: string, on: (v: string) => void): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.rows = 2;
  el.value = value;
  el.addEventListener('change', () => on(el.value));
  return el;
}

function stationFields(level: LevelConfig, st: StationConfig, rerender: () => void): HTMLElement {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    grid(
      field('名称', input(st.name, (v) => { st.name = v; })),
      field('布局 X(0~1)', numInput(st.layout.x, (v) => { st.layout.x = clamp01(v); rerender(); }, 0, 1)),
      field('布局 Y(0~1)', numInput(st.layout.y, (v) => { st.layout.y = clamp01(v); rerender(); }, 0, 1)),
      field('死水位 m', numInput(st.deadLevel, (v) => { st.deadLevel = v; })),
      field('正常蓄水位 m', numInput(st.normalLevel, (v) => { st.normalLevel = v; })),
      field('汛限水位 m', numInput(st.floodLimitLevel, (v) => { st.floodLimitLevel = v; })),
      field('坝顶水位 m', numInput(st.damTopLevel, (v) => { st.damTopLevel = v; })),
      field('初始库容 m³', numInput(st.initialStorage, (v) => { st.initialStorage = Math.max(0, v); }, 0)),
      field('闸门孔数', numInput(st.spillway.gateCount, (v) => { st.spillway.gateCount = Math.max(1, Math.round(v)); }, 1)),
      field('机组台数', numInput(st.plant.unitCount, (v) => { st.plant.unitCount = Math.max(1, Math.round(v)); }, 1)),
      field('单机流量 m³/s', numInput(st.plant.unitFlow, (v) => { st.plant.unitFlow = Math.max(1, v); }, 1)),
      field('单机功率 MW', numInput(st.plant.unitPower, (v) => { st.plant.unitPower = Math.max(1, v); }, 1)),
      field('最小发电水头 m', numInput(st.plant.minHead, (v) => { st.plant.minHead = Math.max(0, v); }, 0)),
      field('额定水头 m', numInput(st.plant.ratedHead, (v) => { st.plant.ratedHead = Math.max(1, v); }, 1)),
    ),
    curveEditor(st, rerender),
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function curveEditor(st: StationConfig, rerender: () => void): HTMLElement {
  const rows = st.levelStorage.map((p, i) => h('tr', {},
    h('td', {}, numInput(p.level, (v) => { p.level = v; }, 0)),
    h('td', {}, numInput(p.storage, (v) => { p.storage = Math.max(0, v); }, 0)),
    h('td', {}, h('button', { class: 'small danger', onClick: () => { if (st.levelStorage.length > 2) { st.levelStorage.splice(i, 1); rerender(); } } }, '删')),
  ));
  const gateRows = st.spillway.capacityCurve.map((p, i) => h('tr', {},
    h('td', {}, numInput(p.x, (v) => { p.x = v; }, 0)),
    h('td', {}, numInput(p.y, (v) => { p.y = Math.max(0, v); }, 0)),
    h('td', {}, h('button', { class: 'small danger', onClick: () => { if (st.spillway.capacityCurve.length > 2) { st.spillway.capacityCurve.splice(i, 1); rerender(); } } }, '删')),
  ));
  return h('div', {},
    h('div', { class: 'ctrl-head', style: { margin: '6px 0' } }, h('strong', { style: { fontSize: '12px' } }, '水位-库容曲线'),
      h('button', { class: 'small', onClick: () => { st.levelStorage.push({ level: st.damTopLevel, storage: st.levelStorage.at(-1)!.storage }); rerender(); } }, '＋加点')),
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, '水位 m'), h('th', {}, '库容 m³'), h('th', {}, ''))), h('tbody', {}, ...rows)),
    h('div', { class: 'ctrl-head', style: { margin: '8px 0 6px' } }, h('strong', { style: { fontSize: '12px' } }, '单孔闸门泄流曲线'),
      h('button', { class: 'small', onClick: () => { st.spillway.capacityCurve.push({ x: st.damTopLevel, y: 0 }); rerender(); } }, '＋加点')),
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, '水位 m'), h('th', {}, '单孔流量 m³/s'), h('th', {}, ''))), h('tbody', {}, ...gateRows)),
  );
}

function reachesTable(level: LevelConfig): HTMLElement {
  const rows = level.reaches.map((r, i) => h('tr', {},
    h('td', {}, input(r.id, (v) => { r.id = v; })),
    h('td', {}, selectStations(level, r.fromStation, (v) => { r.fromStation = v; })),
    h('td', {}, selectStations(level, r.toStation, (v) => { r.toStation = v; })),
    h('td', {}, numInput(r.lagSteps, (v) => { r.lagSteps = Math.max(0, Math.round(v)); }, 0, 20)),
    h('td', {}, numInput(r.lossFactor ?? 0, (v) => { r.lossFactor = clamp01(v); }, 0, 0.5)),
    h('td', {}, h('button', { class: 'small danger', onClick: () => { level.reaches.splice(i, 1); } }, '删')),
  ));
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, '河道ID'), h('th', {}, '上游'), h('th', {}, '下游'), h('th', {}, '时滞(步)'), h('th', {}, '损失系数'), h('th', {}, ''))),
    h('tbody', {}, ...rows),
  );
}

function selectStations(level: LevelConfig, current: string, on: (v: string) => void): HTMLSelectElement {
  const el = document.createElement('select');
  for (const s of level.stations) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} ${s.name}`;
    if (s.id === current) o.selected = true;
    el.append(o);
  }
  el.addEventListener('change', () => on(el.value));
  return el;
}

function addReach(level: LevelConfig, rerender: () => void): void {
  const ids = level.stations.map((s) => s.id);
  if (ids.length < 2) return alert('至少需要两座电站');
  level.reaches.push({ id: `R_${ids[0]}_${ids[1]}_${level.reaches.length}`, fromStation: ids[0], toStation: ids[1], lagSteps: 1, lossFactor: 0 });
  rerender();
}

function inflowFields(level: LevelConfig, stationId: string): HTMLElement {
  const box = h('div', {});
  const render = () => {
    box.replaceChildren();
    const sel = document.createElement('select');
    level.stations.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.id} ${s.name}`;
      if (s.id === stationId) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => { stationId = sel.value; render(); });
    const cfg = level.inflow[stationId];
    if (!cfg) { box.append(sel, h('div', { class: 'danger' }, '该站缺少来水配置')); return; }
    box.append(sel, h('div', { class: 'form-grid', style: { marginTop: '8px' } },
      field('基流 m³/s', numInput(cfg.baseFlow, (v) => { cfg.baseFlow = Math.max(0, v); }, 0)),
      field('季节振幅 m³/s', numInput(cfg.seasonalAmplitude, (v) => { cfg.seasonalAmplitude = Math.max(0, v); }, 0)),
      field('季节周期(步)', numInput(cfg.seasonalPeriodSteps, (v) => { cfg.seasonalPeriodSteps = Math.max(2, Math.round(v)); }, 2)),
      field('噪声比例', numInput(cfg.noiseRatio, (v) => { cfg.noiseRatio = clamp01(v); }, 0, 1)),
      field('暴雨个数', numInput(cfg.stormCount, (v) => { cfg.stormCount = Math.max(0, Math.round(v)); }, 0, 30)),
      field('洪峰倍数下限', numInput(cfg.stormPeakMultiplier[0], (v) => { cfg.stormPeakMultiplier[0] = Math.max(1, v); }, 1)),
      field('洪峰倍数上限', numInput(cfg.stormPeakMultiplier[1], (v) => { cfg.stormPeakMultiplier[1] = Math.max(cfg.stormPeakMultiplier[0], v); })),
      field('暴雨最短(步)', numInput(cfg.stormDurationRange[0], (v) => { cfg.stormDurationRange[0] = Math.max(1, Math.round(v)); }, 1)),
      field('暴雨最长(步)', numInput(cfg.stormDurationRange[1], (v) => { cfg.stormDurationRange[1] = Math.max(cfg.stormDurationRange[0], Math.round(v)); })),
    ));
  };
  render();
  return box;
}

function demandFields(level: LevelConfig, rerender: () => void): HTMLElement {
  const rows = level.demand.segments.map((seg, i) => h('tr', {},
    h('td', {}, numInput(seg.startStep, (v) => { seg.startStep = Math.max(0, Math.round(v)); level.demand.segments.sort((a, b) => a.startStep - b.startStep); rerender(); }, 0)),
    h('td', {}, numInput(seg.flow, (v) => { seg.flow = Math.max(0, v); }, 0)),
    h('td', {}, h('button', { class: 'small danger', onClick: () => { if (level.demand.segments.length > 1) { level.demand.segments.splice(i, 1); rerender(); } } }, '删')),
  ));
  return h('div', {},
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, '起始步'), h('th', {}, '抽水需求 m³/s'), h('th', {}, ''))), h('tbody', {}, ...rows)),
    h('button', { class: 'small', style: { marginTop: '8px' }, onClick: () => { level.demand.segments.push({ startStep: 0, flow: 200 }); level.demand.segments.sort((a, b) => a.startStep - b.startStep); rerender(); } }, '＋新增需求段'),
  );
}

function eventFields(level: LevelConfig): HTMLElement {
  const e = level.events;
  return h('div', { class: 'form-grid' },
    toggleField('暴雨预报偏差', e.stormForecastBias.enabled, (v) => { e.stormForecastBias.enabled = v; }),
    field('  次数', numInput(e.stormForecastBias.count, (v) => { e.stormForecastBias.count = Math.max(0, Math.round(v)); }, 0)),
    field('  偏差幅度', numInput(e.stormForecastBias.magnitude, (v) => { e.stormForecastBias.magnitude = clamp01(v); }, 0, 1)),
    field('  持续步数', numInput(e.stormForecastBias.durationSteps, (v) => { e.stormForecastBias.durationSteps = Math.max(1, Math.round(v)); }, 1)),
    toggleField('机组检修', e.maintenance.enabled, (v) => { e.maintenance.enabled = v; }),
    field('  次数', numInput(e.maintenance.count, (v) => { e.maintenance.count = Math.max(0, Math.round(v)); }, 0)),
    field('  检修机组数', numInput(e.maintenance.unitsDown, (v) => { e.maintenance.unitsDown = Math.max(1, Math.round(v)); }, 1)),
    field('  持续步数', numInput(e.maintenance.durationSteps, (v) => { e.maintenance.durationSteps = Math.max(1, Math.round(v)); }, 1)),
    toggleField('抽水需求变化', e.demandShift.enabled, (v) => { e.demandShift.enabled = v; }),
    field('  次数', numInput(e.demandShift.count, (v) => { e.demandShift.count = Math.max(0, Math.round(v)); }, 0)),
    field('  变化幅度', numInput(e.demandShift.magnitude, (v) => { e.demandShift.magnitude = clamp01(v); }, 0, 1)),
    field('  持续步数', numInput(e.demandShift.durationSteps, (v) => { e.demandShift.durationSteps = Math.max(1, Math.round(v)); }, 1)),
  );
}

function toggleField(label: string, value: boolean, on: (v: boolean) => void): HTMLElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = value;
  el.addEventListener('change', () => on(el.checked));
  return h('label', { style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, el, label);
}

function scoringFields(level: LevelConfig): HTMLElement {
  const s = level.scoring;
  return h('div', { class: 'form-grid' },
    field('每 MWh 得分', numInput(s.pointsPerMwh, (v) => { s.pointsPerMwh = v; })),
    field('超汛限每米每步扣分', numInput(s.floodPenaltyPerMeterStep, (v) => { s.floodPenaltyPerMeterStep = Math.max(0, v); }, 0)),
    field('每 m³/s 缺水扣分', numInput(s.deficitPenaltyPerCms, (v) => { s.deficitPenaltyPerCms = Math.max(0, v); }, 0)),
    field('水位带每步奖励', numInput(s.bandRewardPerStep, (v) => { s.bandRewardPerStep = Math.max(0, v); }, 0)),
    field('期末蓄水每 m³ 奖励', numInput(s.endStorageRewardPerM3, (v) => { s.endStorageRewardPerM3 = Math.max(0, v); }, 0)),
    field('弃水每 m³ 扣分', numInput(s.spillPenaltyPerM3, (v) => { s.spillPenaltyPerM3 = Math.max(0, v); }, 0)),
    field('漫坝一次性扣分', numInput(s.damFailurePenalty, (v) => { s.damFailurePenalty = Math.max(0, v); }, 0)),
    field('一星阈值', numInput(s.starThresholds.one, (v) => { s.starThresholds.one = v; })),
    field('二星阈值', numInput(s.starThresholds.two, (v) => { s.starThresholds.two = v; })),
    field('三星阈值', numInput(s.starThresholds.three, (v) => { s.starThresholds.three = v; })),
  );
}
