// 关卡选择
import { app } from '../state/app';
import { download, fmt, h, upload } from './dom';
import { migrateLevel, validateLevel } from '../persistence/migration';
import type { LevelConfig } from '../core/types';

export function renderLevels(): HTMLElement {
  const wrap = h('div', { class: 'page' },
    h('div', { class: 'topbar' },
      h('button', { class: 'ghost', onClick: () => app.go('menu') }, '← 返回'),
      h('h2', { class: 'page-title' }, '关卡选择'),
      h('div', { class: 'spacer' }),
      h('button', { onClick: importLevel }, '导入关卡 JSON'),
    ),
    h('div', { class: 'page-sub' }, '预置关卡与自定义关卡；点击卡片直接开局。星级记录保存在本地。'),
    h('div', { class: 'grid level-grid', id: 'level-grid' }),
  );
  const grid = wrap.querySelector('#level-grid') as HTMLElement;

  for (const lv of app.allLevels()) {
    const best = app.getBest(lv.id);
    const isCustom = app.customLevels().some((c) => c.id === lv.id);
    const card = h('div', { class: 'level-card card', onClick: () => app.go('game', { level: structuredClone(lv), source: 'level' }) },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('h3', {}, lv.name),
        h('span', { class: 'tag' }, isCustom ? '自定义' : '预置'),
      ),
      h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: 1.5, minHeight: '34px' } }, lv.description),
      h('div', { class: 'level-meta' },
        h('span', {}, `种子 ${lv.seed}`),
        h('span', {}, `${lv.horizonSteps} 步`),
        h('span', {}, `${lv.stations.length} 库`),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('span', { class: 'stars' }, starStr(best?.stars ?? 0)),
        best ? h('span', { class: 'faint mono', style: { fontSize: '12px' } }, `最佳 ${fmt(best.score)} 分`) : h('span', { class: 'faint', style: { fontSize: '12px' } }, '尚未通关'),
      ),
    );
    if (isCustom) {
      card.append(
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { class: 'small', onClick: (e: Event) => { e.stopPropagation(); app.go('editor', { level: structuredClone(lv), source: 'editor' }); } }, '编辑'),
          h('button', { class: 'small', onClick: (e: Event) => { e.stopPropagation(); download(`${lv.id}.json`, JSON.stringify(lv, null, 2)); } }, '导出'),
          h('button', { class: 'small danger', onClick: (e: Event) => { e.stopPropagation(); if (confirm(`删除自定义关卡「${lv.name}」？`)) app.deleteCustomLevel(lv.id); } }, '删除'),
        ),
      );
    }
    grid.append(card);
  }
  return wrap;
}

function starStr(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

async function importLevel(): Promise<void> {
  try {
    const text = await upload();
    const level: LevelConfig = migrateLevel(JSON.parse(text));
    validateLevel(level);
    app.upsertCustomLevel(level);
    alert(`关卡「${level.name}」导入成功`);
    app.go('levels');
  } catch (e) {
    alert('导入失败：' + (e as Error).message);
  }
}
