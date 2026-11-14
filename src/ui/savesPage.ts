// 存档管理：本地存档列表、续档、导入导出、录像导入回放
import { h, toast, upload, download } from './dom';
import { app } from '../state/app';
import { deleteSave, exportSave, importReplay, importSave, listSaves, loadGame, type SaveMeta } from '../persistence/storage';

export function renderSaves(): HTMLElement {
  const wrap = h('div', { class: 'page' },
    h('div', { class: 'topbar' },
      h('button', { class: 'ghost', onClick: () => app.go('menu') }, '← 返回'),
      h('h2', { class: 'page-title' }, '存档管理'),
      h('div', { class: 'spacer' }),
      h('button', { onClick: onImportSave }, '导入存档'),
      h('button', { onClick: onImportReplay }, '导入录像回放'),
    ),
    h('div', { class: 'page-sub' }, '存档内嵌完整关卡快照并带版本号；配置表升级后，老存档经迁移仍可读。'),
    h('div', { class: 'save-list', id: 'save-list' }),
  );
  const list = wrap.querySelector('#save-list') as HTMLElement;

  function rerender(): void {
    const metas = listSaves();
    list.replaceChildren();
    if (!metas.length) {
      list.append(h('div', { class: 'empty-hint' }, '暂无存档。在调度界面点击「快速存档」即可生成。'));
      return;
    }
    for (const m of metas) list.append(row(m, rerender));
  }

  async function onImportSave(): Promise<void> {
    try {
      const f = importSave(await upload());
      toast(`存档「${f.name}」导入成功`);
      rerender();
    } catch (e) {
      alert('导入失败：' + (e as Error).message);
    }
  }
  async function onImportReplay(): Promise<void> {
    try {
      const replay = importReplay(await upload());
      toast('录像载入，开始回放');
      app.go('game', {
        level: replay.level,
        source: 'replay',
        replay: { actions: replay.actions, resultSnapshot: replay.resultSnapshot },
      });
    } catch (e) {
      alert('录像导入失败：' + (e as Error).message);
    }
  }

  rerender();
  return wrap;
}

function row(m: SaveMeta, rerender: () => void): HTMLElement {
  const pct = Math.min(100, (m.currentStep / Math.max(1, m.horizon)) * 100);
  return h('div', { class: 'save-row card' },
    h('div', { class: 'info' },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
        h('span', { class: 'name' }, m.name),
        m.finished ? h('span', { class: 'tag', style: { borderColor: 'var(--good)', color: 'var(--good)' } }, '已完成') : h('span', { class: 'tag' }, '进行中'),
      ),
      h('span', { class: 'muted', style: { fontSize: '12px' } },
        `${m.levelName} · 种子 ${m.seed} · ${new Date(m.savedAt).toLocaleString('zh-CN', { hour12: false })}`),
      h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })),
      h('span', { class: 'faint mono', style: { fontSize: '11px' } }, `进度 ${m.currentStep}/${m.horizon} 步 · 累计 ${Math.round(m.score)} 分`),
    ),
    h('button', { class: 'primary small', onClick: () => continueGame(m) }, m.finished ? '查看回放' : '继续调度'),
    h('button', { class: 'small', onClick: () => exportOne(m) }, '导出'),
    h('button', { class: 'small danger', onClick: () => { if (confirm(`删除存档「${m.name}」？`)) { deleteSave(m.name); rerender(); } } }, '删除'),
  );
}

function continueGame(m: SaveMeta): void {
  const f = loadGame(m.name);
  if (!f) return toast('存档读取失败');
  if (f.finished) {
    app.go('game', { level: f.level, source: 'replay', replay: { actions: f.actions } });
  } else {
    app.go('game', { level: f.level, source: 'save', resumeActions: f.actions });
  }
}

function exportOne(m: SaveMeta): void {
  const f = loadGame(m.name);
  if (!f) return;
  download(`${m.name.replace(/[\\/:*?"<>|\s]/g, '_')}.json`, exportSave(f));
  toast('存档已导出');
}
