// 折线插值与水文小工具（纯函数，无随机性）
import type { LevelStoragePoint, XYPoint } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 通用折线插值，pts 的 x 必须升序；超出范围按端点外推 */
export function interp(pts: XYPoint[], x: number): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

/** 水位 -> 库容 */
export function levelToStorage(points: LevelStoragePoint[], level: number): number {
  return interp(points.map((p) => ({ x: p.level, y: p.storage })), level);
}

/** 库容 -> 水位（单调反查） */
export function storageToLevel(points: LevelStoragePoint[], storage: number): number {
  const inv = points.map((p) => ({ x: p.storage, y: p.level }));
  return interp(inv, storage);
}

/** 流量 m³/s 持续 dt 秒的体积 m³ */
export function flowToVolume(flowCms: number, dtSeconds: number): number {
  return flowCms * dtSeconds;
}

/** 体积 m³ 折算回平均流量 m³/s */
export function volumeToFlow(volumeM3: number, dtSeconds: number): number {
  return volumeM3 / dtSeconds;
}

/** 数字保留指定小数（仅用于展示/序列化清洗） */
export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
