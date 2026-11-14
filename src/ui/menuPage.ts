// 主菜单
import { app } from '../state/app';
import { h } from './dom';

export function renderMenu(): HTMLElement {
  const go = (screen: Parameters<typeof app.go>[0]) => () => app.go(screen);
  return h('div', { class: 'menu-wrap' },
    h('div', { class: 'menu-title' }, '梯级水库调度演练'),
    h('div', { class: 'menu-sub' }, 'CASCADE RESERVOIR DISPATCH TRAINER'),
    h('div', { class: 'menu-grid' },
      menuBtn('🗺️', '关卡选择', go('levels')),
      menuBtn('🛠️', '关卡编辑器', go('editor')),
      menuBtn('📊', '平衡模拟', go('batch')),
      menuBtn('💾', '存档管理', go('saves')),
      menuBtn('📘', '操作手册', showHelp),
      menuBtn('🌊', '快速开局', () => {
        const lv = app.defaultLevels()[0];
        app.go('game', { level: lv, source: 'level' });
      }),
    ),
    h('div', { class: 'faint', style: { marginTop: '26px', fontSize: '12px' } },
      '四座电站 · 发电 / 防洪 / 供水权衡 · 种子随机来水 · 全程可回放 · 水量严格守恒'),
  );
}

function menuBtn(ico: string, label: string, onClick: () => void): HTMLElement {
  return h('button', { class: 'menu-btn card', onClick }, h('span', { class: 'ico' }, ico), h('span', {}, label));
}

export function showHelp(): void {
  const mask = h('div', { class: 'modal-mask', onClick: (e: Event) => { if (e.target === mask) mask.remove(); } });
  const modal = h('div', { class: 'modal card' },
    h('h2', {}, '操作手册'),
    helpBlock('目标', '在一条河的四座电站间权衡发电收益、防洪安全与下游供水。总分=发电+水位带奖励+期末蓄水−超汛限−供水缺口−弃水−漫坝。'),
    helpBlock('每步操作（6 小时一步）', '每座库可调【闸门开度 0~100%】与【开机台数】。发电流量优先满足，其余经闸门泄洪。点“推进一步”生效。'),
    helpBlock('看预报', '主界面显示未来 3 步来水预报；注意暴雨预报偏差事件——预报可能偏大或偏小，实际来水以蓝色过程线为准。'),
    helpBlock('突发事件', '暴雨预报偏差、机组检修（可用机组减少）、下游抽水需求变化。事件在顶部横幅与库角“!”提示。'),
    helpBlock('硬约束', '水位超坝顶即漫坝判负（一次性重扣）；超汛限水位按超高一米每步扣分；死水位以下无法继续放水。'),
    helpBlock('确定性与回放', '同一种子+同一串操作结果完全一致。结束后可导出录像 JSON，他人导入即可逐帧复盘。'),
    helpBlock('平衡模拟', '内置 4 种自动策略，可对几十上百个派生种子批量跑，输出胜率、三星率与得分分布，用于检验关卡平衡性。'),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
      h('button', { class: 'primary', onClick: () => mask.remove() }, '知道了')),
  );
  mask.append(modal);
  document.body.append(mask);
}

function helpBlock(title: string, body: string): HTMLElement {
  return h('div', {},
    h('div', { style: { color: 'var(--accent)', fontWeight: 700, marginBottom: '3px' } }, title),
    h('div', { class: 'muted', style: { lineHeight: '1.65' } }, body),
  );
}
