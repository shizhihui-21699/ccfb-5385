// 存档管理：localStorage 持久化 + JSON 导入导出 + 录像生成
import type { LevelConfig, StepAction } from '../core/types';
import {
  SAVE_SCHEMA_VERSION,
  parseReplayFile,
  parseSaveFile,
  type ReplayFile,
  type SaveFile,
} from './migration';

const SAVE_KEY = 'cascade-dispatch:saves:v2';

export interface SaveMeta {
  name: string;
  savedAt: string;
  levelId: string;
  levelName: string;
  seed: string;
  currentStep: number;
  horizon: number;
  score: number;
  finished: boolean;
}

function readAll(): SaveFile[] {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => parseSaveFile(x));
  } catch (e) {
    console.error('读取存档失败', e);
    return [];
  }
}

function writeAll(files: SaveFile[]): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(files));
}

export function listSaves(): SaveMeta[] {
  return readAll()
    .map((f) => ({
      name: f.name,
      savedAt: f.savedAt,
      levelId: f.levelId,
      levelName: f.level.name,
      seed: f.seed,
      currentStep: f.currentStep,
      horizon: f.level.horizonSteps,
      score: Math.round(f.score),
      finished: f.finished,
    }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function saveGame(input: {
  name: string;
  level: LevelConfig;
  actions: StepAction[];
  currentStep: number;
  score: number;
  finished: boolean;
}): SaveFile {
  const files = readAll();
  const file: SaveFile = {
    format: 'cascade-dispatch-save',
    schemaVersion: SAVE_SCHEMA_VERSION,
    configVersion: input.level.configVersion,
    savedAt: new Date().toISOString(),
    name: input.name,
    levelId: input.level.id,
    seed: input.level.seed,
    level: structuredClone(input.level),
    actions: structuredClone(input.actions),
    currentStep: input.currentStep,
    score: input.score,
    finished: input.finished,
  };
  const idx = files.findIndex((f) => f.name === file.name);
  if (idx >= 0) files[idx] = file;
  else files.push(file);
  writeAll(files);
  return file;
}

export function loadGame(name: string): SaveFile | undefined {
  return readAll().find((f) => f.name === name);
}

export function deleteSave(name: string): void {
  writeAll(readAll().filter((f) => f.name !== name));
}

export function exportSave(file: SaveFile): string {
  return JSON.stringify(file, null, 2);
}

export function importSave(text: string): SaveFile {
  const parsed = parseSaveFile(JSON.parse(text));
  const files = readAll();
  const idx = files.findIndex((f) => f.name === parsed.name);
  if (idx >= 0) files[idx] = parsed;
  else files.push(parsed);
  writeAll(files);
  return parsed;
}

export function buildReplay(level: LevelConfig, actions: StepAction[], result: {
  finalScore: number;
  stars: number;
  steps: number;
  failed: boolean;
}): ReplayFile {
  return {
    format: 'cascade-dispatch-replay',
    schemaVersion: SAVE_SCHEMA_VERSION,
    configVersion: level.configVersion,
    recordedAt: new Date().toISOString(),
    level: structuredClone(level),
    actions: structuredClone(actions),
    resultSnapshot: result,
  };
}

export function exportReplay(replay: ReplayFile): string {
  return JSON.stringify(replay, null, 2);
}

export function importReplay(text: string): ReplayFile {
  return parseReplayFile(JSON.parse(text));
}

/** 浏览器端下载 JSON 文件 */
export function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 浏览器端读取本地 JSON 文件 */
export function uploadJson(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('未选择文件'));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
      reader.readAsText(file);
    };
    input.click();
  });
}
