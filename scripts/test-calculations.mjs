#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, flush } from './test-support.mjs';

const near = (actual, expected) => assert(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
const referenceModel = { id: 'test/reference', name: 'Reference API', inputPrice: 4, cachedPrice: 0.2, outputPrice: 20, checked: true };
const monthlyDemand = 35406976000;
const monthlyCost = 92782.72;

test('independent financial reference: cost, capacity, blend, bill, breakeven and curve', async t => {
  const app = await createApp(t);
  const r = app.calculateScenario(app.defaults, [referenceModel]);
  assert.equal(r.valid, true);
  near(r.annualTco, 1113392.64);
  near(r.monthlyCost, monthlyCost);
  near(r.annualTotalTokens, 3029529600000);
  near(r.monthlySupply, 252460800000);
  near(r.monthlySupply * 12, r.annualTotalTokens);
  near(r.monthlyDemand, monthlyDemand);
  near(r.costPerMAt100, 1113392.64 / 3029529.6);
  near(r.costAtDerivedUtil, monthlyCost / 35406.976);
  near(r.derivedUtil, monthlyDemand / 252460800000 * 100);
  near(r.frontierResults[0].blended, 1.900625);
  near(r.frontierResults[0].monthlyFrontierCost, 35406.976 * 1.900625);
  near(r.frontierResults[0].breakeven, (1113392.64 / 3029529.6) / 1.900625 * 100);
  assert.equal(r.selfHostedCosts.length, 100);
  near(r.selfHostedCosts[0], 1113392.64 / 30295.296);
  near(r.selfHostedCosts[49], 1113392.64 / 1514764.8);
  near(r.selfHostedCosts[99], r.costPerMAt100);
});

test('usage scaling, speed independence, capacity independence and cache-only billing', async t => {
  const app = await createApp(t);
  const calc = changes => app.calculateScenario({ ...app.defaults, ...changes }, [referenceModel]);
  const baseline = calc({});
  for (const [id, value, factor] of [['numUsers', 400, 2], ['sessionsPerDay', 2, 2], ['callsPerSession', 502.94, 2], ['workDays', 11, 0.5]]) {
    const r = calc({ [id]: value });
    near(r.monthlyDemand, monthlyDemand * factor);
    near(r.frontierResults[0].monthlyFrontierCost, baseline.frontierResults[0].monthlyFrontierCost * factor);
    near(r.costAtDerivedUtil, baseline.costAtDerivedUtil / factor);
    assert.equal(r.frontierResults[0].blended, baseline.frontierResults[0].blended);
    assert.equal(r.frontierResults[0].breakeven, baseline.frontierResults[0].breakeven);
  }
  for (const speed of [0, 64]) {
    const r = calc({ outputTpsPerUser: speed });
    near(r.monthlyDemand, monthlyDemand);
    near(r.costAtDerivedUtil, baseline.costAtDerivedUtil);
  }
  const capacity = calc({ totalGoodput: 192000 });
  near(capacity.derivedUtil, baseline.derivedUtil / 2);
  near(capacity.costPerMAt100, baseline.costPerMAt100 / 2);
  near(capacity.costAtDerivedUtil, baseline.costAtDerivedUtil);
  near(capacity.frontierResults[0].monthlyFrontierCost, baseline.frontierResults[0].monthlyFrontierCost);
  for (const [cacheHitRate, blended] of [[0, 5], [100, 1.4375]]) {
    const r = calc({ cacheHitRate });
    near(r.monthlyDemand, monthlyDemand);
    near(r.monthlySupply, baseline.monthlySupply);
    near(r.costPerMAt100, baseline.costPerMAt100);
    near(r.frontierResults[0].blended, blended);
  }
  near(calc({ avgOsl: 1000 }).monthlyDemand, 34300508000);
  near(calc({ avgIsl: 60000 }).monthlyDemand, 68601016000);
});

test('zero demand, zero capacity, exact capacity and overload are distinct', async t => {
  const app = await createApp(t);
  for (const id of ['numUsers', 'sessionsPerDay', 'callsPerSession']) {
    const r = app.calculateScenario({ ...app.defaults, [id]: 0 }, [referenceModel]);
    assert.equal(r.monthlyDemand, 0);
    assert.equal(r.derivedUtil, 0);
    assert.equal(r.costAtDerivedUtil, null);
    near(r.monthlyCost, monthlyCost);
    assert.equal(r.frontierResults[0].monthlyFrontierCost, 0);
  }
  app.set('totalGoodput', 0);
  let r = app.compute();
  assert.equal(r.derivedUtil, null);
  assert.equal(r.costPerMAt100, null);
  assert.equal(r.costAtDerivedUtil, null);
  assert.equal(r.frontierResults[0].breakeven, null);
  assert.match(app.$('derivedUtil').textContent, /no capacity/);
  assert.match(app.$('shCostAtUtil').textContent, /insufficient capacity/);
  assert.equal(app.$('shCostPerM').textContent, 'N/A');
  app.set('totalGoodput', 96000);
  app.set('sessionsPerDay', 10);
  r = app.compute();
  assert(r.derivedUtil > 100);
  assert.equal(r.costAtDerivedUtil, null);
  assert.match(app.$('derivedUtil').textContent, /exceeds capacity/);
  near(r.monthlyDemand, monthlyDemand * 10);
  const exact = app.calculateScenario({ ...app.defaults, totalGoodput: monthlyDemand / 2629800 }, [referenceModel]);
  near(exact.derivedUtil, 100);
  near(exact.costAtDerivedUtil, exact.costPerMAt100);
});

test('invalid and overflowing inputs cannot produce financial results', async t => {
  const app = await createApp(t);
  for (const [id, value] of [['cacheHitRate', 200], ['cacheHitRate', -1], ['totalGoodput', -1], ['numNodes', 0], ['numNodes', 1.5], ['gpusPerNode', 145], ['costPerNode', -1], ['avgIsl', 0], ['avgOsl', 0], ['numUsers', -1], ['workDays', 32], ['callsPerSession', ''], ['sessionsPerDay', '']]) {
    app.set(id, value);
    assert.equal(app.compute().valid, false, id);
    assert.equal(app.$(id).getAttribute('aria-invalid'), 'true');
    assert.equal(app.$('shCostAtUtil').textContent, 'N/A');
    assert.equal(app.$('breakevenBody').children.length, 0);
    app.set(id, app.defaults[id]);
    assert.equal(app.compute().valid, true, id);
  }
  for (const value of [Infinity, NaN, 1e308]) assert.equal(app.calculateScenario({ ...app.defaults, sessionsPerDay: value }, [referenceModel]).valid, false);
  app.set('price-0-inputPrice', -1);
  assert.equal(app.compute().valid, false);
  app.set('price-0-inputPrice', 0);
  assert.equal(app.compute().valid, true);
  const free = app.calculateScenario(app.defaults, [{ ...referenceModel, inputPrice: 0, cachedPrice: 0, outputPrice: 0 }]);
  assert.equal(free.frontierResults[0].breakeven, Infinity);
  assert.equal(free.frontierResults[0].monthlyFrontierCost, 0);
});

test('both pinned Weka references change only calls/session', async t => {
  const app = await createApp(t);
  const buttons = [...app.window.document.querySelectorAll('[data-calls-per-session]')];
  assert.deepEqual(buttons.map(b => b.dataset.callsPerSession), ['251.47', '173.70']);
  app.set('sessionsPerDay', 0.5);
  for (const [index, expected] of [251.47, 173.70].entries()) {
    const before = [...app.window.document.querySelectorAll('input, select, textarea')].map(el => [el, el.value]);
    buttons[index].click();
    assert.equal(Number(app.$('callsPerSession').value), expected);
    for (const [el, value] of before) if (el.id !== 'callsPerSession') assert.equal(el.value, value, el.id);
    near(app.compute().monthlyDemand, 200 * 0.5 * expected * 22 * 32000);
  }
});

test('every preset maps all benchmark fields and preserves edited demand inputs', async t => {
  const app = await createApp(t);
  assert.equal(app.presets.length, 23);
  const demand = { numUsers: 300, sessionsPerDay: 0.5, callsPerSession: 100, workDays: 20 };
  Object.entries(demand).forEach(([id, value]) => app.set(id, value));
  const verify = preset => {
    for (const [id, value] of Object.entries({ ...preset.values, ...demand })) assert.equal(app.$(id).value, String(value), `${preset.id}: ${id}`);
    assert.equal(app.$('hfSearch').value, preset.source.model);
    assert.equal(app.$('scenarioName').value, preset.label);
    assert(app.$('presetProvenance').classList.contains('open'));
    const r = app.compute();
    near(r.monthlyDemand, 300000 * (preset.values.avgIsl + preset.values.avgOsl));
    near(r.monthlyCost, preset.values.numNodes * preset.values.costPerNode);
    near(r.monthlySupply, preset.values.totalGoodput * 2629800);
    r.frontierResults.forEach(m => near(m.monthlyFrontierCost, m.blended * r.monthlyDemand / 1e6));
  };
  app.presets.forEach((preset, i) => { app.preset(i); verify(preset); });
  const buttons = [...app.$('presetQuick').querySelectorAll('button')];
  const featured = app.presets.filter(p => p.featured);
  assert.ok(featured.length >= 1 && featured.length <= 3, 'one to three featured presets');
  assert.equal(buttons.length, featured.length);
  buttons.forEach(button => { button.click(); verify(app.presets.find(p => p.id === button.dataset.presetId)); });
});

test('frontier pricing is part of the main results column, not the input sidebar', async t => {
  const app = await createApp(t);
  const doc = app.window.document;
  const aside = doc.querySelector('.frontier-aside');
  assert.ok(aside);
  assert.ok(aside.closest('.main'));
  assert.equal(aside.closest('.sidebar'), null);
  assert.ok(aside.querySelector('#frontierList'));
  assert.equal(doc.title, 'Self-Hosted vs Frontier API LLM Cost Calculator');
  assert.equal(doc.querySelector('h1').textContent, 'Self-Hosted vs Frontier API Cost Calculator');
});

test('at-a-glance verdict reflects demand, capacity and model selection states', async t => {
  const app = await createApp(t);
  const verdict = () => app.$('verdictText').textContent;

  app.compute();
  assert.match(verdict(), /cheapest enabled API/);
  assert.match(verdict(), /Break-even with GPT-6\.1 Terra/);
  assert.notEqual(app.$('verdictSelfHosted').textContent, 'N/A');
  assert.match(app.$('verdictBestApi').textContent, /^\$\S+\/M$/);
  assert.match(app.$('verdictBills').textContent, /^\$/);
  assert.match(app.$('verdictBillsSub').textContent, /^vs \$/);
  assert.match(app.$('verdictBillsSub').textContent, /cheapest API/);
  assert.match(app.$('verdictUtil').textContent, /^14/);

  app.set('numUsers', 1400);
  assert.match(verdict(), /below every enabled frontier API/);

  app.set('numUsers', 0);
  assert.match(verdict(), /demand is zero/);
  assert.equal(app.$('verdictSelfHosted').textContent, 'N/A');

  app.set('numUsers', 200);
  app.set('totalGoodput', 0);
  assert.match(verdict(), /no measured capacity/);
  assert.equal(app.$('verdictSelfHosted').textContent, 'N/A');

  app.set('totalGoodput', 96000);
  app.set('sessionsPerDay', 10);
  assert.match(verdict(), /exceeds the fleet's measured capacity/);
  assert.equal(app.$('verdictUtil').classList.contains('warn'), true);

  app.set('sessionsPerDay', 1);
  const doc = app.window.document;
  const checkboxes = [...doc.querySelectorAll('.frontier-list input[type="checkbox"]')];
  checkboxes.forEach(cb => { if (cb.checked) cb.click(); });
  assert.match(verdict(), /Enable at least one frontier model/);
  assert.equal(app.$('verdictBestApi').textContent, 'N/A');

  checkboxes[0].click();
  assert.match(app.$('verdictBestApiSub').textContent, /Claude Opus 5\.5/);

  app.set('cacheHitRate', 200);
  assert.match(verdict(), /Correct the highlighted inputs/);
});

test('log scale toggle switches the chart y-axis; linear stays the default', async t => {
  const app = await createApp(t);
  const yAxis = () => app.getChart().config.options.scales.y;
  assert.equal(yAxis().type, 'linear');
  assert.equal(yAxis().min, 0);

  app.$('logScale').checked = true;
  app.$('logScale').dispatchEvent(new app.window.Event('change'));
  assert.equal(yAxis().type, 'logarithmic');
  assert(yAxis().min > 0);
  assert(yAxis().max > yAxis().min);

  app.$('logScale').checked = false;
  app.$('logScale').dispatchEvent(new app.window.Event('change'));
  assert.equal(yAxis().type, 'linear');
  assert.equal(yAxis().min, 0);
});

test('benchmark edits clear measured attribution; demand edits preserve it', async t => {
  const app = await createApp(t);
  app.preset(0);
  app.set('numUsers', 250);
  assert.equal(app.$('presetSelect').value, '0');
  for (const id of Object.keys(app.presets[0].values)) {
    app.preset(0);
    app.set(id, id === 'gpuType' ? 'Custom GPU' : Number(app.$(id).value) + 1);
    assert.equal(app.$('presetSelect').value, 'custom', id);
    assert(!app.$('presetProvenance').classList.contains('open'));
    assert.match(app.$('scenarioName').value, /^Custom/);
  }
});

test('real DOM pricing edits, accordion state and checkbox selection affect outputs', async t => {
  const app = await createApp(t);
  const doc = app.window.document;
  assert.equal(doc.querySelectorAll('.frontier-prices input').length, app.models.length * 3);
  const expand = doc.querySelector('.frontier-expand');
  expand.click();
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  for (const [field, value] of Object.entries({ inputPrice: 4, cachedPrice: 0.2, outputPrice: 20 })) app.set(`price-0-${field}`, value);
  near(app.compute().frontierResults[0].blended, 1.900625);
  app.set('price-0-cachedPrice', 1);
  near(app.compute().frontierResults[0].blended, 2.553125);
  assert.equal(app.$('blended-0').textContent, `$${(2.553125).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/M`);
  const checkboxes = [...doc.querySelectorAll('.frontier-list input[type="checkbox"]')];
  assert.equal(checkboxes.length, app.models.length);
  checkboxes.forEach(cb => { if (cb.checked) cb.click(); });
  assert.equal(app.compute().frontierResults.length, 0);
  assert.equal(app.$('breakevenBody').children.length, 0);
  checkboxes[0].click();
  assert.equal(app.compute().frontierResults.length, 1);
  assert.equal(app.$('breakevenBody').children.length, 1);
});

test('native print regenerates current values, including zero demand and invalid input', async t => {
  const app = await createApp(t);
  const print = () => app.window.dispatchEvent(new app.window.Event('beforeprint'));
  print();
  assert(app.$('printContent').textContent.includes('Monthly API Bill at Estimated Demand'));
  assert(!app.$('printOverlay').classList.contains('active'));
  app.set('numUsers', 0);
  print();
  assert.equal(app.$('shCostAtUtil').textContent, 'N/A');
  assert(app.$('printContent').textContent.includes('N/A/M tokens'));
  app.$('scenarioName').value = '<script>test</script>';
  app.$('btnPrint').click();
  assert.equal(app.$('printContent').querySelectorAll('script').length, 0);
  assert(app.$('printOverlay').classList.contains('active'));
  app.set('cacheHitRate', 200);
  print();
  assert.match(app.$('printContent').textContent, /between 0 and 100/);
});

test('initial snapshot works during a pending request and live updates preserve user edits', async t => {
  let resolve;
  const app = await createApp(t, { fetch: () => new Promise(r => { resolve = r; }) });
  assert.notEqual(app.$('annualTco').textContent, '—');
  assert(app.$('breakevenBody').children.length > 0);
  app.set('price-0-inputPrice', 7);
  app.window.document.querySelector('.frontier-list input[type="checkbox"]').click();
  resolve({ ok: true, json: async () => ({ data: app.models.map(m => ({ id: m.id, pricing: { prompt: '0.000010', completion: '0.000020' } })) }) });
  await flush();
  assert.equal(app.getModels()[0].inputPrice, 7);
  assert.equal(app.getModels()[0].checked, false);
  assert.equal(app.getModels()[0].cachedPrice, 10);
  assert.match(app.$('frontierLoading').textContent, /missing cache prices use input rates/);
});

test('failed, malformed, partial and timed-out API responses keep usable snapshot output', async t => {
  for (const [name, fetch] of [
    ['network', async () => { throw new Error('offline'); }],
    ['HTTP', async () => ({ ok: false, status: 503 })],
    ['JSON', async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })],
    ['schema', async () => ({ ok: true, json: async () => ({ error: 'bad schema' }) })],
  ]) await t.test(name, async t => {
    const app = await createApp(t, { fetch });
    assert.match(app.$('frontierLoading').textContent, /unavailable.*snapshot/);
    assert(app.$('breakevenBody').children.length > 0);
    assert.equal(app.warnings.length, 1);
  });
  const app = await createApp(t);
  const resolved = app.resolveFrontierPricing({ data: [{ id: app.models[0].id, pricing: { prompt: '0.000010', completion: '0.000020' } }] });
  assert.equal(resolved.models[0].cachedPrice, 10);
  assert.equal(resolved.models[0].inputPrice, 10);
  assert.equal(resolved.snapshotCount, app.models.length - 1);
  let signal;
  app.window.fetch = (url, options) => { signal = options.signal; return new Promise(() => {}); };
  await assert.rejects(app.fetchJSON('https://example.test', 5), /timed out/);
  assert.equal(signal.aborted, true);
});

test('missing Chart.js leaves the numerical comparison and print view usable', async t => {
  const app = await createApp(t, { chart: false });
  assert.equal(app.$('chartStatus').hidden, false);
  assert(app.$('breakevenBody').children.length > 0);
  app.$('btnPrint').click();
  assert.match(app.$('printContent').textContent, /Chart unavailable/);
});

test('model search uses real events and ignores stale responses', async t => {
  const app = await createApp(t);
  app.preset(0);
  const responses = [];
  app.window.fetch = () => new Promise(resolve => responses.push(resolve));
  const old = app.searchHF('old');
  const current = app.searchHF('current');
  responses[1]({ ok: true, json: async () => [{ id: 'org/current-model', downloads: 100 }] });
  await current;
  responses[0]({ ok: true, json: async () => [{ id: 'org/old-model' }] });
  await old;
  assert.match(app.$('hfResults').textContent, /current-model/);
  assert.doesNotMatch(app.$('hfResults').textContent, /old-model/);
  app.$('hfResults').firstElementChild.click();
  assert.equal(app.$('hfSearch').value, 'org/current-model');
  assert.equal(app.$('presetSelect').value, 'custom');
  app.set('hfSearch', 'x'); // Exercise the actual input listener and its timer APIs.
  assert(!app.$('hfResults').classList.contains('open'));
});
