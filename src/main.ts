// 应用入口：屏幕路由
import './ui/styles.css';
import { app } from './state/app';
import { renderMenu } from './ui/menuPage';
import { renderLevels } from './ui/levelsPage';
import { renderGame } from './ui/gamePage';
import { renderEditor } from './ui/editorPage';
import { renderBatch } from './ui/batchPage';
import { renderSaves } from './ui/savesPage';

const root = document.getElementById('app')!;

function route(): void {
  switch (app.screen) {
    case 'menu':
      root.replaceChildren(renderMenu());
      break;
    case 'levels':
      root.replaceChildren(renderLevels());
      break;
    case 'game':
      if (!app.launch) { app.go('levels'); return; }
      root.replaceChildren(renderGame(app.launch));
      break;
    case 'editor':
      root.replaceChildren(renderEditor(app.launch?.level));
      break;
    case 'batch':
      root.replaceChildren(renderBatch());
      break;
    case 'saves':
      root.replaceChildren(renderSaves());
      break;
  }
  window.scrollTo(0, 0);
}

app.sub(route);
route();
