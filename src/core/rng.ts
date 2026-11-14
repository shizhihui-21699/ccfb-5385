// 确定性随机数：同一种子产生完全一致的序列，引擎内所有随机性都走这里
// 禁止在核心仿真里使用 Math.random / Date.now

/** 字符串种子 -> 32bit 无符号整数（FNV-1a） */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG，返回 [0,1) */
export function makeRng(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 派生子随机流：主种子 + 通道名，互不干扰 */
export function deriveRng(rootSeed: string, channel: string): () => number {
  return makeRng(hashSeed(rootSeed + '::' + channel));
}

/** [min,max) 均匀分布 */
export function range(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**  Box-Muller 正态分布 */
export function gaussian(rng: () => number, mean = 0, sd = 1): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 从数组中确定性抽取 n 个不重复下标 */
export function pickIndexes(rng: () => number, length: number, n: number): number[] {
  const idx = Array.from({ length }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, length));
}
