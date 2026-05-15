import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SETTINGS_FILE = join(ROOT, 'data', 'layout-settings.json');
export const ALLOWED_WIDGET_IDS = ['zone-mascot', 'zone-terminal', 'zone-office'];

const DEFAULTS = {
  widgetOrder: [...ALLOWED_WIDGET_IDS],
  hiddenWidgets: [],
  collapsedWidgets: {},
  defaultPanel: 'zone-office',
  savedLayouts: [],
};

function uniqueStrings(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map((v) => String(v || '').trim()).filter(Boolean))];
}

function normalizeLayoutPreset(input = {}, index = 0) {
  const widgetOrder = uniqueStrings(input.widgetOrder).filter((id) => ALLOWED_WIDGET_IDS.includes(id));
  const completedOrder = [...widgetOrder, ...ALLOWED_WIDGET_IDS.filter((id) => !widgetOrder.includes(id))];
  const hiddenWidgets = uniqueStrings(input.hiddenWidgets).filter((id) => ALLOWED_WIDGET_IDS.includes(id));
  const collapsedWidgets = Object.fromEntries(
    Object.entries(input.collapsedWidgets || {})
      .filter(([id]) => ALLOWED_WIDGET_IDS.includes(String(id || '').trim()))
      .map(([id, value]) => [String(id), !!value]),
  );
  const defaultPanel = ALLOWED_WIDGET_IDS.includes(String(input.defaultPanel || '').trim())
    ? String(input.defaultPanel).trim()
    : completedOrder.find((id) => !hiddenWidgets.includes(id)) || DEFAULTS.defaultPanel;
  return {
    id: String(input.id || `layout-${index + 1}`).trim().slice(0, 80),
    name: String(input.name || `Layout ${index + 1}`).trim().slice(0, 80),
    widgetOrder: completedOrder,
    hiddenWidgets,
    collapsedWidgets,
    defaultPanel,
  };
}

function normalize(input = {}) {
  const rawOrder = uniqueStrings(input.widgetOrder?.length ? input.widgetOrder : DEFAULTS.widgetOrder)
    .filter((id) => ALLOWED_WIDGET_IDS.includes(id));
  const widgetOrder = [...rawOrder, ...ALLOWED_WIDGET_IDS.filter((id) => !rawOrder.includes(id))];
  const hiddenWidgets = uniqueStrings(input.hiddenWidgets).filter((id) => ALLOWED_WIDGET_IDS.includes(id));
  const collapsedWidgets = Object.fromEntries(
    Object.entries(input.collapsedWidgets || {})
      .filter(([id]) => ALLOWED_WIDGET_IDS.includes(String(id || '').trim()))
      .map(([id, value]) => [String(id), !!value]),
  );
  const visibleWidgets = widgetOrder.filter((id) => !hiddenWidgets.includes(id));
  const defaultPanel = ALLOWED_WIDGET_IDS.includes(String(input.defaultPanel || '').trim()) && !hiddenWidgets.includes(String(input.defaultPanel || '').trim())
    ? String(input.defaultPanel).trim()
    : (visibleWidgets[0] || DEFAULTS.defaultPanel);
  return {
    widgetOrder,
    hiddenWidgets,
    collapsedWidgets,
    defaultPanel,
    savedLayouts: Array.isArray(input.savedLayouts) ? input.savedLayouts.slice(0, 20).map(normalizeLayoutPreset) : [],
  };
}

export async function loadLayoutSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...normalize(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveLayoutSettings(input) {
  const settings = normalize(input);
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}
