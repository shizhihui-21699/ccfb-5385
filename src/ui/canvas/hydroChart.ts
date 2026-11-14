// 底部过程线图：多序列时序 + 播放头 + 悬浮读数
import { clamp } from '../../core/interp';
import type { StepRecord } from '../../core/types';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** 从某步记录取值 */
  value: (r: StepRecord, stationId?: string) => number;
  stationId?: string;
  axis: 'left' | 'right';
}

export const SERIES_INFLOW: ChartSeries = {
  key: 'inflow', label: '入库流量', color: '#38bdf8', axis: 'left',
  value: (r, sid) => r.stations.find((s) => s.stationId === sid)?.inflow ?? 0,
};
export const SERIES_RELEASE: ChartSeries = {
  key: 'release', label: '出库流量', color: '#34d399', axis: 'left',
  value: (r, sid) => r.stations.find((s) => s.stationId === sid)?.totalRelease ?? 0,
};
export const SERIES_LEVEL: ChartSeries = {
  key: 'level', label: '水位', color: '#fbbf24', axis: 'right',
  value: (r, sid) => r.stations.find((s) => s.stationId === sid)?.level ?? 0,
};
export const SERIES_SCORE: ChartSeries = {
  key: 'score', label: '累计得分', color: '#c084fc', axis: 'right',
  value: (r) => r.totalScore,
};
export const SERIES_DEMAND: ChartSeries = {
  key: 'demand', label: '下游需求', color: '#f87171', axis: 'left',
  value: (r) => r.demand,
};

export class HydroChart {
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private hoverStep = -1;
  private onSeek: ((step: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener('mousemove', (e) => {
      const step = this.stepAt(e);
      if (step >= 0) this.hoverStep = step;
    });
    canvas.addEventListener('mouseleave', () => (this.hoverStep = -1));
    canvas.addEventListener('click', (e) => {
      const step = this.stepAt(e);
      if (step >= 0 && this.onSeek) this.onSeek(step);
    });
  }

  setSeekHandler(fn: (step: number) => void): void {
    this.onSeek = fn;
  }

  dispose(): void {
    this.ro.disconnect();
  }

  private stepAt(e: MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const m = this.metrics();
    if (x < m.l || x > m.l + m.plotW) return -1;
    return clamp(Math.floor(((x - m.l) / m.plotW) * this.horizon), 0, this.horizon - 1);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const cw = rect.width || 600;
    const ch = rect.height || 150;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  private get w() { return this.canvas.clientWidth; }
  private get h() { return this.canvas.clientHeight; }

  private records: StepRecord[] = [];
  private horizon = 1;
  private currentStep = 0;
  private series: ChartSeries[] = [];

  setData(records: StepRecord[], horizon: number, currentStep: number, series: ChartSeries[]): void {
    this.records = records;
    this.horizon = Math.max(1, horizon);
    this.currentStep = currentStep;
    this.series = series;
    this.draw();
  }

  private metrics() {
    const l = 46, r = 46, t = 12, b = 24;
    return { l, r, t, b, plotW: this.w - l - r, plotH: this.h - t - b };
  }

  draw(): void {
    const ctx = this.ctx;
    const m = this.metrics();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(10,20,36,0.6)';
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.records.length === 0 || this.series.length === 0) return;

    const left = this.series.filter((s) => s.axis === 'left');
    const right = this.series.filter((s) => s.axis === 'right');
    const maxL = Math.max(1, ...left.flatMap((s) => this.records.map((r) => s.value(r, s.stationId))));
    const minR = Math.min(0, ...right.flatMap((s) => this.records.map((r) => s.value(r, s.stationId))));
    const maxR = Math.max(1, ...right.flatMap((s) => this.records.map((r) => s.value(r, s.stationId))));

    // 网格与轴标
    ctx.strokeStyle = 'rgba(120,160,220,0.12)';
    ctx.fillStyle = '#5f7799';
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = m.t + (m.plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + m.plotW, y); ctx.stroke();
      ctx.fillText(Math.round(maxL * (1 - i / 4)).toString(), 4, y + 3);
      const rv = maxR + (minR - maxR) * (i / 4);
      ctx.fillText(Math.round(rv).toString(), m.l + m.plotW + 6, y + 3);
    }

    const xAt = (step: number) => m.l + (step / this.horizon) * m.plotW;
    const yL = (v: number) => m.t + m.plotH * (1 - v / maxL);
    const yR = (v: number) => m.t + m.plotH * (1 - (v - minR) / Math.max(1e-9, maxR - minR));

    // 序列
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      this.records.forEach((r, i) => {
        const v = s.value(r, s.stationId);
        const y = s.axis === 'left' ? yL(v) : yR(v);
        const x = xAt(i);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 播放头
    const px = xAt(Math.min(this.currentStep, this.horizon - 1));
    ctx.strokeStyle = 'rgba(227,236,247,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, m.t); ctx.lineTo(px, m.t + m.plotH); ctx.stroke();
    ctx.setLineDash([]);

    // 步轴标签
    ctx.fillStyle = '#5f7799';
    for (let i = 0; i <= 4; i++) {
      const step = Math.round((this.horizon * i) / 4);
      ctx.fillText(`步${step}`, xAt(step) - 10, this.h - 7);
    }

    // 悬浮读数
    if (this.hoverStep >= 0 && this.hoverStep < this.records.length) {
      const hx = xAt(this.hoverStep);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.moveTo(hx, m.t); ctx.lineTo(hx, m.t + m.plotH); ctx.stroke();
      const rec = this.records[this.hoverStep];
      const lines = [`步 ${rec.step}`, ...this.series.map((s) => `${s.label}: ${s.value(rec, s.stationId).toFixed(1)}`)];
      const boxW = 118, boxH = 14 * lines.length + 10;
      let bx = hx + 8;
      if (bx + boxW > this.w) bx = hx - boxW - 8;
      const by = m.t + 6;
      ctx.fillStyle = 'rgba(10,22,40,0.94)';
      ctx.strokeStyle = '#2c456e';
      ctx.beginPath(); ctx.rect(bx, by, boxW, boxH); ctx.fill(); ctx.stroke();
      ctx.font = '11px sans-serif';
      lines.forEach((ln, i) => {
        if (i === 0) {
          ctx.fillStyle = '#e3ecf7';
          ctx.font = 'bold 11px sans-serif';
        } else {
          ctx.fillStyle = this.series[i - 1].color;
          ctx.font = '11px sans-serif';
        }
        ctx.fillText(ln, bx + 8, by + 16 + i * 14);
      });
    }

    // 图例
    let lx = m.l;
    ctx.font = '11px sans-serif';
    for (const s of this.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, this.h - 20, 10, 3);
      ctx.fillStyle = '#8aa3c4';
      ctx.fillText(s.label, lx + 14, this.h - 16);
      lx += ctx.measureText(s.label).width + 34;
    }
  }
}
