#!/usr/bin/env node
// Dependency-free calculation and interaction smoke tests for the inline app.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
new vm.Script(inline); // Check the unmodified production script, too.

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.value = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.markup = '';
    this.text = '';
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
      },
    };
  }
  set innerHTML(value) { this.markup = value; this.text = ''; this.children = []; }
  get innerHTML() { return this.markup + escapeHtml(this.text) + this.children.map(c => c.innerHTML).join(''); }
  set textContent(value) { this.text = String(value); this.markup = ''; this.children = []; }
  get textContent() { return this.text; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  fire(type) {
    assert(this.listeners.has(type), `Missing ${type} listener`);
    this.listeners.get(type).forEach(fn => fn({ target: this }));
  }
  querySelectorAll(selector) {
    return selector === 'button' ? this.children.filter(c => c.tag === 'button') : [];
  }
  querySelector(selector) {
    const preset = selector.match(/^\[data-preset-id="([^"]+)"\]$/);
    return preset ? this.children.find(c => c.dataset.presetId === preset[1]) : new Element();
  }
  toDataURL() { return 'data:image/png;base64,'; }
}

const elements = new Map();
const markup = html.slice(0, html.lastIndexOf('<script>'));
for (const [, tag, attributes, id] of markup.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const el = new Element(tag);
  el.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
  elements.set(id, el);
}
const references = [...markup.matchAll(/<button\b[^>]*data-calls-per-session="([^"]+)"[^>]*>/g)].map(([, value]) => {
  const btn = new Element('button');
  btn.dataset.callsPerSession = value;
  return btn;
});
const $ = id => {
  assert(elements.has(id), `Unknown element #${id}`);
  return elements.get(id);
};
const defaults = new Map([...elements].map(([id, el]) => [id, el.value]));
const context = vm.createContext({
  document: {
    getElementById: id => elements.get(id) ?? null,
    createElement: tag => new Element(tag),
    addEventListener() {},
    querySelectorAll(selector) {
      return selector === '[data-calls-per-session]'
        ? references
        : selector.split(',').map(s => $(s.trim().slice(1)));
    },
  },
  Chart: class { destroy() {} },
  // An empty catalog exercises the baked-price fallback for each model.
  fetch: async () => ({ json: async () => ({ data: [] }) }),
  console: { warn() {}, error: (...args) => assert.fail(args.join(' ')) },
});
const marker = '  // --- Init ---';
assert(inline.includes(marker));
vm.runInContext(inline.replace(marker,
  `  globalThis.testApi = { compute, presets: SCENARIO_PRESETS };\n${marker}`), context);
await new Promise(resolve => setImmediate(resolve));
const { compute, presets } = context.testApi;
const reset = () => defaults.forEach((value, id) => { $(id).value = value; });
const set = (id, value) => { $(id).value = String(value); $(id).fire('input'); };
const near = (actual, expected) => assert(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
const demand = result => result.derivedUtil / 100 * Number($('totalGoodput').value) * 30.44 * 86400;

const baseline = compute();
const baselineCost = $('shCostAtUtil').textContent;
const monthlyDemand = 200 * 1 * 251.47 * 22 * (30000 + 2000);
near(demand(baseline), monthlyDemand);
assert.equal($('dailyCallsPerUser').textContent, '251.47');
near(baseline.frontierResults[0].monthlyFrontierCost, monthlyDemand / 1e6 * 1.900625);

for (const [id, value, factor] of [
  ['numUsers', 400, 2], ['sessionsPerDay', 2, 2],
  ['callsPerSession', 502.94, 2], ['workDays', 11, 0.5],
]) {
  reset();
  set(id, value);
  const result = compute();
  near(demand(result), monthlyDemand * factor);
  result.frontierResults.forEach((m, i) => {
    near(m.monthlyFrontierCost, baseline.frontierResults[i].monthlyFrontierCost * factor);
    assert.equal(m.blended, baseline.frontierResults[i].blended);
    assert.equal(m.breakeven, baseline.frontierResults[i].breakeven);
  });
}

reset();
set('outputTpsPerUser', 64);
near(demand(compute()), monthlyDemand);
assert.equal($('shCostAtUtil').textContent, baselineCost);
set('outputTpsPerUser', 0);
near(demand(compute()), monthlyDemand);
set('totalGoodput', 192000);
const moreCapacity = compute();
near(moreCapacity.derivedUtil, baseline.derivedUtil / 2);
assert.equal($('shCostAtUtil').textContent, baselineCost);
near(moreCapacity.frontierResults[0].monthlyFrontierCost, baseline.frontierResults[0].monthlyFrontierCost);

reset();
set('avgOsl', 1000);
near(demand(compute()), monthlyDemand * 31000 / 32000);
reset();
set('cacheHitRate', 0);
const uncached = compute();
near(demand(uncached), monthlyDemand);
assert.equal(uncached.costPerMAt100, baseline.costPerMAt100);
assert(uncached.frontierResults[0].blended > baseline.frontierResults[0].blended);

for (const reference of references) {
  reset();
  set('sessionsPerDay', 0.5);
  const before = new Map([...elements].map(([id, el]) => [id, el.value]));
  reference.fire('click');
  assert.equal($('callsPerSession').value, reference.dataset.callsPerSession);
  before.forEach((value, id) => { if (id !== 'callsPerSession') assert.equal($(id).value, value); });
  near(demand(compute()), 200 * 0.5 * Number(reference.dataset.callsPerSession) * 22 * 32000);
}

const demandInputs = { numUsers: 300, sessionsPerDay: 0.5, callsPerSession: 100, workDays: 20 };
reset();
Object.entries(demandInputs).forEach(([id, value]) => set(id, value));
presets.forEach((preset, i) => {
  $('presetSelect').value = String(i);
  $('presetSelect').fire('change');
  Object.entries(demandInputs).forEach(([id, value]) => assert.equal($(id).value, String(value)));
  const before = compute();
  const expected = 300 * 0.5 * 100 * 20 * (preset.values.avgIsl + preset.values.avgOsl);
  near(demand(before), expected);
  set('outputTpsPerUser', preset.values.outputTpsPerUser * 2);
  const after = compute();
  near(demand(after), expected);
  after.frontierResults.forEach(m => near(m.monthlyFrontierCost, m.blended * expected / 1e6));
});
$('presetQuick').children[0].fire('click');
Object.entries(demandInputs).forEach(([id, value]) => assert.equal($(id).value, String(value)));

reset();
set('sessionsPerDay', 0.5);
$('btnPrint').fire('click');
const print = $('printContent').innerHTML;
for (const label of ['Sessions / User / Day', 'Avg Model Calls / Session', 'Model Calls / User / Day', 'Monthly API Bill at Estimated Demand']) assert(print.includes(label));
assert(!/Active Hours|Duty Cycle/.test(print));
assert($('mathExplanation').innerHTML.includes('Calls/user/day'));
assert(!/timePerTurn|turnsPerEffHour|activeHrs|dutyCycle/.test(inline));

for (const id of ['numUsers', 'sessionsPerDay', 'callsPerSession']) {
  reset();
  set(id, 0);
  const result = compute();
  near(demand(result), 0);
  assert.equal($('shCostAtUtil').textContent, 'N/A');
  assert.equal($('annualTco').textContent, '$1,113,393');
  result.frontierResults.forEach(m => assert.equal(m.monthlyFrontierCost, 0));
}

console.log(`PASS: session demand, API bills, Weka buttons, print view, and ${presets.length} benchmark presets.`);
