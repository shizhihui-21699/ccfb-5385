// Canvas 梯级河道主视图：河道、四库水位、泄流箭头、预报、事件标记
// 视觉动画可用 rAF 时间，但不接触仿真数据，不影响确定性
import type { EngineView } from '../../core/engine';
import { clamp } from '../../core/interp';
import type { GameEvent, LevelConfig, StationConfig } from '../../core/types';

const PAD = 70;

interface StationScreen {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export class RiverView {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private ro: ResizeObserver;
  private stations: StationScreen[] = [];
  private onClick: ((stationId: string) => void) | null = null;
  private animT = 0;
  private raf = 0;
  private lastDrawArgs: Parameters<RiverView['draw']> | null = null;

  constructor(canvas: HTMLCanvasElement, private level: LevelConfig) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
    this.ro = new ResizeObserver(() => {
      this.resize();
      if (this.lastDrawArgs) this.draw(...this.lastDrawArgs);
    });
    this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener('click', (e) => this.handleClick(e));
    const loop = () => {
      this.animT += 0.016;
      if (this.lastDrawArgs) this.draw(...this.lastDrawArgs);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }

  setClickHandler(fn: (stationId: string) => void): void {
    this.onClick = fn;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    // 容器尚未布局完成时使用后备尺寸，避免 width=0 导致首帧空白；ResizeObserver 会在布局后纠正
    const cw = rect.width || 800;
    const ch = rect.height || 420;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private get w(): number {
    return this.canvas.clientWidth;
  }
  private get h(): number {
    return this.canvas.clientHeight;
  }

  private layoutStations(): void {
    this.stations = this.level.stations.map((s) => ({
      id: s.id,
      cx: PAD + s.layout.x * (this.w - 2 * PAD),
      cy: 90 + s.layout.y * (this.h - 230),
      w: 86,
      h: 118,
    }));
  }

  private handleClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: string | null = null;
    let bestD = 52;
    for (const st of this.stations) {
      const d = Math.hypot(x - st.cx, y - (st.cy + 10));
      if (d < bestD) {
        bestD = d;
        best = st.id;
      }
    }
    if (best && this.onClick) this.onClick(best);
  }

  draw(view: EngineView, records: { step: number; stations: { stationId: string; level: number; totalRelease: number; inflow: number }[] }[], selectedId: string, activeEvents: GameEvent[]): void {
    this.lastDrawArgs = [view, records, selectedId, activeEvents];
    const ctx = this.ctx;
    this.layoutStations();
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawBackground();
    this.drawRiver();
    view.stations.forEach((sv, i) => {
      const screen = this.stations[i];
      const cfg = sv.cfg;
      const events = activeEvents.filter((ev) => !ev.stationId || ev.stationId === cfg.id);
      this.drawStation(cfg, screen, sv.level, sv.inflow, sv.totalRelease, sv.effectiveUnits, sv.activeUnits, selectedId === cfg.id, events);
    });
    this.drawReachFlows(view);
    this.drawDemandOutlet(view);
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#0f1f38');
    g.addColorStop(1, '#0b1526');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.strokeStyle = 'rgba(120,160,220,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < this.w; x += 44) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke();
    }
    for (let y = 0; y < this.h; y += 44) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
    }
  }

  private drawRiver(): void {
    const ctx = this.ctx;
    if (this.stations.length < 2) return;
    ctx.lineCap = 'round';
    // 河床
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(59,130,246,0.18)';
    ctx.lineWidth = 26;
    ctx.moveTo(this.stations[0].cx - 60, this.stations[0].cy + 12);
    for (let i = 1; i < this.stations.length; i++) {
      const p = this.stations[i - 1];
      const c = this.stations[i];
      ctx.quadraticCurveTo((p.cx + c.cx) / 2, p.cy + 40, c.cx, c.cy + 12);
    }
    ctx.stroke();
    // 流动水线
    ctx.strokeStyle = 'rgba(96,165,250,0.55)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 16]);
    ctx.lineDashOffset = -this.animT * 40;
    ctx.beginPath();
    ctx.moveTo(this.stations[0].cx - 60, this.stations[0].cy + 12);
    for (let i = 1; i < this.stations.length; i++) {
      const p = this.stations[i - 1];
      const c = this.stations[i];
      ctx.quadraticCurveTo((p.cx + c.cx) / 2, p.cy + 40, c.cx, c.cy + 12);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawStation(
    cfg: StationConfig,
    s: StationScreen,
    level: number,
    inflow: number,
    release: number,
    effectiveUnits: number,
    activeUnits: number,
    selected: boolean,
    events: GameEvent[],
  ): void {
    const ctx = this.ctx;
    const x = s.cx - s.w / 2;
    const y = s.cy - s.h / 2 + 18;
    const ratio = clamp((level - cfg.deadLevel) / (cfg.damTopLevel - cfg.deadLevel), 0, 1);
    const floodRatio = clamp((cfg.floodLimitLevel - cfg.deadLevel) / (cfg.damTopLevel - cfg.deadLevel), 0, 1);
    const overFlood = level > cfg.floodLimitLevel;
    const danger = level >= cfg.damTopLevel - 0.5;

    // 选中环
    if (selected) {
      ctx.beginPath();
      ctx.arc(s.cx, y + s.h / 2, s.w * 0.72, 0, Math.PI * 2);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 库体外框
    ctx.fillStyle = 'rgba(12,24,42,0.85)';
    ctx.strokeStyle = overFlood ? '#f87171' : '#3d5d8c';
    ctx.lineWidth = 2;
    this.roundRect(x, y, s.w, s.h, 8);
    ctx.fill();
    ctx.stroke();

    // 水体
    const waterH = (s.h - 10) * ratio;
    const wg = ctx.createLinearGradient(0, y + s.h - waterH, 0, y + s.h);
    if (danger) {
      wg.addColorStop(0, '#ef4444');
      wg.addColorStop(1, '#7f1d1d');
    } else if (overFlood) {
      wg.addColorStop(0, '#fb923c');
      wg.addColorStop(1, '#c2410c');
    } else {
      wg.addColorStop(0, '#38bdf8');
      wg.addColorStop(1, '#1d4ed8');
    }
    ctx.fillStyle = wg;
    ctx.beginPath();
    this.roundRectPath(x + 4, y + s.h - 5 - waterH, s.w - 8, waterH, 5);
    ctx.fill();
    // 水面波纹
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const wy = y + s.h - 5 - waterH;
    for (let i = 0; i < 3; i++) {
      const ox = ((this.animT * 24 + i * 12) % (s.w - 8));
      ctx.moveTo(x + 4 + ox, wy + 2 + i * 2);
      ctx.lineTo(x + 4 + ox + 6, wy + 2 + i * 2);
    }
    ctx.stroke();

    // 汛限线
    const fy = y + s.h - 5 - (s.h - 10) * floodRatio;
    ctx.strokeStyle = '#f87171';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x + 3, fy); ctx.lineTo(x + s.w - 3, fy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fca5a5';
    ctx.font = '10px sans-serif';
    ctx.fillText('汛限', x + s.w - 26, fy - 3);

    // 坝体
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(x - 6, y + s.h);
    ctx.lineTo(x + s.w + 6, y + s.h);
    ctx.lineTo(x + s.w - 8, y + s.h + 12);
    ctx.lineTo(x + 8, y + s.h + 12);
    ctx.closePath();
    ctx.fill();

    // 名称与数值
    ctx.fillStyle = '#e3ecf7';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cfg.name, s.cx, y - 8);
    ctx.font = 'bold 15px "SF Mono", monospace';
    ctx.fillStyle = overFlood ? '#fca5a5' : '#7dd3fc';
    ctx.fillText(`${level.toFixed(1)}m`, s.cx, y + 20);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8aa3c4';
    ctx.fillText(`${Math.round(inflow)}→ ${Math.round(release)} m³/s`, s.cx, y + s.h + 28);
    // 机组状态点
    for (let u = 0; u < cfg.plant.unitCount; u++) {
      ctx.beginPath();
      ctx.arc(s.cx - (cfg.plant.unitCount - 1) * 7 + u * 14, y + s.h + 42, 4, 0, Math.PI * 2);
      ctx.fillStyle = u < activeUnits ? '#facc15' : u < effectiveUnits ? '#475569' : '#7f1d1d';
      ctx.fill();
    }
    ctx.textAlign = 'left';

    // 事件角标
    if (events.length) {
      ctx.fillStyle = events.some((e) => e.type === 'maintenance') ? '#f87171' : '#fbbf24';
      ctx.beginPath();
      ctx.arc(x + s.w - 2, y + 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', x + s.w - 2, y + 8);
      ctx.textAlign = 'left';
    }
  }

  private drawReachFlows(view: EngineView): void {
    const ctx = this.ctx;
    for (let i = 1; i < this.stations.length; i++) {
      const p = this.stations[i - 1];
      const c = this.stations[i];
      const mx = (p.cx + c.cx) / 2;
      const my = (p.cy + c.cy) / 2 + 26;
      const reach = this.level.reaches.find((r) => r.fromStation === p.id && r.toStation === c.id);
      const rel = view.stations[i - 1].totalRelease;
      ctx.fillStyle = 'rgba(8,18,34,0.85)';
      this.roundRect(mx - 46, my - 11, 92, 22, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(96,165,250,0.4)';
      ctx.stroke();
      ctx.fillStyle = '#9fc4ef';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(rel)} m³/s · 滞${reach?.lagSteps ?? 0}步`, mx, my + 4);
      ctx.textAlign = 'left';
    }
  }

  private drawDemandOutlet(view: EngineView): void {
    const ctx = this.ctx;
    const last = this.stations[this.stations.length - 1];
    if (!last) return;
    const x = last.cx + 64;
    const y = last.cy + 12;
    ctx.strokeStyle = 'rgba(52,211,153,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(last.cx + 40, y);
    ctx.lineTo(x + 30, y);
    ctx.stroke();
    ctx.fillStyle = '#6ee7b7';
    ctx.font = '11px sans-serif';
    ctx.fillText(`下游供水`, x - 4, y - 8);
    ctx.fillStyle = view.outletFlow < view.demand ? '#fca5a5' : '#6ee7b7';
    ctx.fillText(`${Math.round(view.outletFlow)}/${Math.round(view.demand)} m³/s`, x - 4, y + 16);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.roundRectPath(x, y, w, h, r);
    this.ctx.fill();
    this.ctx.stroke();
  }
  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
