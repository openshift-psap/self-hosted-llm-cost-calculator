import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreset, eligible, hitRate, nodeSizeFor, paretoFrontier, pickOperatingPoint, totalGpus } from './refresh-presets.mjs';
import { perMillion, pickModels } from './refresh-pricing.mjs';
import { createApp } from './test-support.mjs';

const row = (id, throughput, interactivity, extra = {}) => ({
  id, model: 'test-model', hardware: 'h200', framework: 'vllm', precision: 'fp8',
  date: '2026-10-01', run_url: 'https://example.test/run/1', benchmark_type: 'agentic_traces',
  disagg: false, num_prefill_gpu: 8, num_decode_gpu: 8, conc: 32,
  metrics: { total_tput_tps: throughput, median_intvty: interactivity, mean_input_tokens: 30000, mean_output_tokens_actual: 2000, server_gpu_cache_hit_rate: 0.87 },
  ...extra,
});

test('Pareto frontier rejects dominated points regardless of date', () => {
  const fast = row('fast', 200, 40);
  const interactive = row('interactive', 100, 60);
  const dominated = row('dominated', 150, 35, { date: '2026-10-31' });
  assert.deepEqual(paretoFrontier([dominated, fast, interactive]).map(r => r.id), ['fast', 'interactive']);
  assert.equal(pickOperatingPoint([dominated, fast, interactive]).id, 'fast');
});

test('selection respects the target, uses the most interactive fallback, and breaks ties by date', () => {
  assert.equal(pickOperatingPoint([row('target', 100, 35), row('slower', 200, 34)]).id, 'target');
  assert.equal(pickOperatingPoint([row('interactive', 100, 34), row('throughput', 200, 21)]).id, 'interactive');
  assert.equal(pickOperatingPoint([row('old', 100, 40), row('new', 100, 40, { date: '2026-10-31' })]).id, 'new');
  assert.equal(pickOperatingPoint([]), undefined);
});

test('cache eligibility requires a real measured rate in [0, 1]', () => {
  for (const measured of [null, undefined, '', false, '0.8', -0.1, 1.5, NaN, Infinity]) {
    const r = row('missing', 100, 40);
    r.metrics.server_gpu_cache_hit_rate = measured;
    r.metrics.theoretical_cache_hit_rate = 0.8;
    assert.equal(hitRate(r), null, String(measured));
    assert.equal(eligible(r), false);
  }
  for (const measured of [0, 0.5, 1]) {
    const r = row('measured', 100, 40);
    r.metrics.server_gpu_cache_hit_rate = measured;
    assert.equal(hitRate(r), measured);
    assert.equal(eligible(r), true);
  }
  assert.equal(eligible(row('slow', 100, 19)), false);
  assert.equal(eligible(row('no capacity', 0, 40)), false);
  assert.equal(eligible(row('bad concurrency', 100, 40, { conc: null })), false);
});

test('topology uses catalog sizes, explicit NVL domains and TPU accounting units; unknown topology fails', () => {
  assert.equal(nodeSizeFor([{ key: 'h200-sxm', scaleUpWorldSize: 8 }], { key: 'h200', label: 'H200' }), 8);
  assert.equal(nodeSizeFor([], { key: 'vr200', label: 'Vera Rubin NVL72' }), 72);
  assert.equal(nodeSizeFor([], { key: 'tpuv7', label: 'TPU7x' }), 8);
  assert.throws(() => nodeSizeFor([], { key: 'unknown', label: 'Unknown' }), /missing node topology/);
  assert.throws(() => nodeSizeFor([{ key: 'unknown', scaleUpWorldSize: -1 }], { key: 'unknown', label: 'Unknown' }), /missing node topology/);
  assert.equal(totalGpus(row('aggregate', 100, 40)), 8);
  assert.equal(totalGpus(row('disagg', 100, 40, { disagg: true, num_prefill_gpu: 8, num_decode_gpu: 16 })), 24);
});

test('preset mapping retains same-run measurements and rental fleet cost for all node shapes', () => {
  for (const [gpus, nodeSize, expectedNodes, expectedSize] of [[32, 72, 1, 32], [144, 72, 2, 72], [16, 8, 2, 8], [4, 8, 1, 4]]) {
    const r = row('mapping', 123456.7, 37.25, { num_prefill_gpu: gpus, num_decode_gpu: gpus });
    const p = buildPreset({ model: 'Test', hardware: 'test' }, r, { label: 'Test GPU', costPerHour: { r: 8.5 } }, nodeSize);
    assert.equal(p.values.numNodes, expectedNodes);
    assert.equal(p.values.gpusPerNode, expectedSize);
    assert.equal(p.values.costPerNode * p.values.numNodes, gpus * 730 * 8.5);
    assert.equal(p.values.totalGoodput, 123457);
    assert.equal(p.values.cacheHitRate, 87);
    assert.equal(p.values.avgIsl, 30000);
    assert.equal(p.values.avgOsl, 2000);
    assert.equal(p.values.outputTpsPerUser, 37.3);
    assert.equal(p.values.concurrency, 32);
    for (const id of ['numUsers', 'sessionsPerDay', 'callsPerSession', 'workDays']) assert.equal(id in p.values, false);
  }
});

// Deliberately independent of the current live/snapshot catalog versions.
const familyIds = ['anthropic/claude-opus-1', 'anthropic/claude-sonnet-1', 'anthropic/claude-fable-1', 'anthropic/claude-haiku-1',
  'openai/gpt-1-sol', 'openai/gpt-1-terra', 'openai/gpt-1-sol-pro', 'google/gemini-1-argon', 'google/gemini-1-flash',
  'x-ai/grok-1', 'amazon/nova-premier-v1', 'cohere/command-a-plus'];
const catalog = () => ({ data: familyIds.map(id => ({ id, name: `Provider: ${id}`, created: 1, pricing: { prompt: '0.000004', input_cache_read: '0.0000002', completion: '0.000020' } })) });

test('pricing conversion validates numbers and preserves cached-price precision', () => {
  assert.equal(perMillion('0.000000003', 3), 0.003);
  assert.equal(perMillion('0.0000008333'), 0.83);
  assert.equal(perMillion('0'), 0);
  for (const value of [null, undefined, '', ' ', true, '-1', '1oops', 'Infinity', 1e308]) assert.equal(perMillion(value), null, String(value));
});

test('pricing selects the newest closed model in each narrow, provider-contiguous family', () => {
  const payload = catalog();
  payload.data.push({ ...payload.data[0], id: 'anthropic/claude-opus-2', created: 2 });
  payload.data.push({ ...payload.data[0], id: 'anthropic/claude-opus-3:free', created: 3 });
  payload.data.push({ ...payload.data[0], id: 'deepseek/test', created: 4 });
  const models = pickModels(payload);
  assert.equal(models.length, 12);
  assert.equal(models[0].id, 'anthropic/claude-opus-2');
  assert.deepEqual(models.map(m => m.id.split('/')[0]), familyIds.map(id => id.split('/')[0]));
  assert.equal(models[0].name.startsWith('Provider:'), false);
  assert.throws(() => pickModels({ error: 'bad schema' }), /missing data array/);
  assert.throws(() => pickModels({ data: [] }), /no OpenRouter model matched/);
  delete payload.data[4].pricing.prompt;
  assert.throws(() => pickModels(payload), /missing pricing/);
});

test('browser and maintenance script agree on missing/invalid cached-price policy', async t => {
  const app = await createApp(t);
  for (const cache of [undefined, null, '', -1, '0.000000003', '0']) {
    const payload = catalog();
    payload.data[0].pricing = { prompt: '0.000010', completion: '0.000020', input_cache_read: cache };
    const maintenance = pickModels(payload)[0];
    const browser = app.resolveFrontierPricing(payload, [{ ...referenceSnapshot(), id: familyIds[0] }]).models[0];
    for (const field of ['inputPrice', 'cachedPrice', 'outputPrice']) assert.equal(browser[field], maintenance[field], `${cache}: ${field}`);
  }
});

function referenceSnapshot() { return { name: 'Reference', inputPrice: 4, cachedPrice: 0.2, outputPrice: 20, checked: true }; }
