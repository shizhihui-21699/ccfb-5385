// 极简 hyperscript DOM 构建器，保持零依赖
export type VNode = HTMLElement;

type Child = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v);
    } else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function mount(el: HTMLElement, node: Node): void {
  el.replaceChildren(node);
}

/** 轻量全局提示 */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, ms = 2200): void {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** 大体积转 亿m³ / 万m³ */
export function fmtVolume(m3: number): string {
  if (Math.abs(m3) >= 1e8) return `${(m3 / 1e8).toFixed(2)}亿m³`;
  if (Math.abs(m3) >= 1e4) return `${(m3 / 1e4).toFixed(1)}万m³`;
  return `${fmt(m3)}m³`;
}

export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function upload(accept = '.json,application/json'): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('未选择文件'));
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error('读取失败'));
      r.readAsText(f);
    };
    input.click();
  });
}
