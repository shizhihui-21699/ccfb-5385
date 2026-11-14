// 全局状态与屏幕路由（发布订阅，无框架）
import { buildDefaultLevels } from '../data/defaultLevels';
import { migrateLevel, validateLevel } from '../persistence/migration';
import type { LevelConfig, StepAction } from '../core/types';

export type Screen = 'menu' | 'levels' | 'game' | 'editor' | 'batch' | 'saves';

export interface GameLaunch {
  level: LevelConfig;
  /** 续档时带入的历史操作 */
  resumeActions?: StepAction[];
  /** 回放模式：只播放不可编辑 */
  replay?: { actions: StepAction[]; resultSnapshot?: unknown };
  source: 'level' | 'editor' | 'save' | 'replay';
}

export interface BestResult {
  stars: number;
  score: number;
  at: string;
}

const CUSTOM_KEY = 'cascade-dispatch:custom-levels:v2';
const BEST_KEY = 'cascade-dispatch:best:v2';

type Listener = () => void;

class AppStore {
  screen: Screen = 'menu';
  launch: GameLaunch | null = null;
  private levels: LevelConfig[] = buildDefaultLevels();
  private customs: LevelConfig[] = this.loadCustoms();
  private best: Record<string, BestResult> = this.loadBest();
  private listeners = new Set<Listener>();

  sub(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  go(screen: Screen, launch: GameLaunch | null = null): void {
    this.screen = screen;
    this.launch = launch;
    this.emit();
  }

  allLevels(): LevelConfig[] {
    return [...this.levels, ...this.customs];
  }
  defaultLevels(): LevelConfig[] {
    return this.levels;
  }
  customLevels(): LevelConfig[] {
    return this.customs;
  }
  findLevel(id: string): LevelConfig | undefined {
    return this.allLevels().find((l) => l.id === id);
  }

  upsertCustomLevel(level: LevelConfig): void {
    validateLevel(level);
    const idx = this.customs.findIndex((l) => l.id === level.id);
    if (idx >= 0) this.customs[idx] = level;
    else this.customs.push(level);
    this.persistCustoms();
    this.emit();
  }

  deleteCustomLevel(id: string): void {
    this.customs = this.customs.filter((l) => l.id !== id);
    this.persistCustoms();
    this.emit();
  }

  getBest(levelId: string): BestResult | undefined {
    return this.best[levelId];
  }
  recordBest(levelId: string, stars: number, score: number): void {
    const cur = this.best[levelId];
    if (!cur || score > cur.score) {
      this.best[levelId] = { stars, score, at: new Date().toISOString() };
      this.persistBest();
      this.emit();
    }
  }

  private loadCustoms(): LevelConfig[] {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (!raw) return [];
      return (JSON.parse(raw) as unknown[]).map((x) => migrateLevel(x));
    } catch (e) {
      console.error('自定义关卡读取失败', e);
      return [];
    }
  }
  private persistCustoms(): void {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(this.customs));
  }
  private loadBest(): Record<string, BestResult> {
    try {
      return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}');
    } catch {
      return {};
    }
  }
  private persistBest(): void {
    localStorage.setItem(BEST_KEY, JSON.stringify(this.best));
  }
}

export const app = new AppStore();
