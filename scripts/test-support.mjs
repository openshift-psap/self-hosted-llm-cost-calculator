import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

export const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
export const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
new vm.Script(inline);
export const flush = () => new Promise(resolve => setImmediate(resolve));

// A real HTML parser/DOM handles generated controls and event registration.
// Only the network and canvas/chart engine are replaced; Playwright covers
// the real Chart.js engine, layout, accessibility and printing separately.
export async function createApp(t, { fetch = async () => ({ ok: true, json: async () => ({ data: [] }) }), chart = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://calculator.example/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);
  window.fetch = fetch;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,test';
  if (chart) window.Chart = class {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; }
    destroy() { this.destroyed = true; }
    stop() {}
    update() {}
  };
  const $ = id => {
    const el = window.document.getElementById(id);
    if (!el) throw new Error(`Unknown element #${id}`);
    return el;
  };
  const defaults = Object.fromEntries([...window.document.querySelectorAll('input[type="number"]')].map(el => [el.id, Number(el.value)]));
  const marker = '  // --- Init ---';
  if (!inline.includes(marker)) throw new Error('Missing application initialization marker');
  window.eval(inline.replace(marker, `
    window.testApi = { calculateScenario, compute, render, presets: SCENARIO_PRESETS, models: FRONTIER_MODELS,
      resolveFrontierPricing, fetchJSON, searchHF, getModels: () => frontierModels, getChart: () => chart };
${marker}`));
  await flush();
  const set = (id, value) => { $(id).value = String(value); $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const preset = i => { $('presetSelect').value = String(i); $('presetSelect').dispatchEvent(new window.Event('change')); };
  return { window, $, defaults, set, preset, warnings, ...window.testApi };
}
