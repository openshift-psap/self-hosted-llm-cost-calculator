#!/usr/bin/env node
/**
 * Refresh the scenario preset snapshot in index.html from the InferenceX API.
 *
 * For each curated (model, hardware) pair below, picks the best measured
 * agentic-traces run on a vLLM- or SGLang-family serving stack (vllm,
 * dynamo-vllm, llmd-vllm, vllm-disagg, sglang, dynamo-sglang) — latest
 * date, then highest output throughput among runs meeting an interactivity
 * floor — and derives the calculator's serving-side inputs from that run:
 *
 *   - prefill goodput   = input_tput_tps          (raw: cache hits included)
 *   - output goodput    = output_tput_tps         (fleet total)
 *   - cache hit rate    = server_gpu_cache_hit_rate (measured, same run)
 *   - ISL / OSL         = mean_input_tokens / mean_output_tokens_actual
 *   - tok/s per user    = median_intvty
 *   - $/node/month      = rental $/GPU-hr x 730 x GPUs per node
 *
 * Demand-estimate inputs (users, active hours, duty cycle, working days) are
 * deliberately NOT set by presets — they stay at the repo defaults.
 *
 * The InferenceX API does not send CORS headers, so presets are baked into
 * index.html as a snapshot (same pattern as the frontier pricing snapshot).
 *
 * Usage:
 *   node scripts/refresh-presets.mjs          # preview changes (dry run)
 *   node scripts/refresh-presets.mjs --write  # update index.html
 *   node scripts/refresh-presets.mjs --check  # exit 1 if index.html is stale
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const API = 'https://inferencex.semianalysis.com';

const START_MARKER = '  // BEGIN SCENARIO_PRESETS';
const END_MARKER = '  // END SCENARIO_PRESETS';

/** Minimum median interactivity (tok/s per session) for a usable preset. */
const INTERACTIVITY_FLOOR = 20;
/** Hours per month used to convert $/GPU-hr into $/node/month. */
const HOURS_PER_MONTH = 730;

/**
 * Curated preset catalog, restricted to vLLM- and SGLang-family serving
 * stacks. `featured: true` marks the quick-select buttons shown directly in
 * the UI (first three are used).
 */
const CURATED = [
  { model: 'GLM-5.2', hardware: 'gb200', featured: true },
  { model: 'Kimi-K3', hardware: 'tpuv7', featured: true },
  { model: 'Muse-Spark-Open', hardware: 'mi355x', featured: true },
  { model: 'GLM-5.2', hardware: 'h200' },
  { model: 'GLM-5.2', hardware: 'b200' },
  { model: 'GLM-5.2', hardware: 'mi355x' },
  { model: 'GLM-5.2', hardware: 'gb300' },
  { model: 'Kimi-K3', hardware: 'mi355x' },
  { model: 'Kimi-K3', hardware: 'vr200' },
  { model: 'Kimi-K3', hardware: 'gb300' },
  { model: 'Muse-Spark-Open', hardware: 'h200' },
  { model: 'Muse-Spark-Open', hardware: 'gb200' },
  { model: 'MiniMax-M3.1-Flash', hardware: 'gb200' },
  { model: 'MiniMax-M3.1-Flash', hardware: 'h200' },
  { model: 'MiniMax-M3.1-Flash', hardware: 'mi355x' },
  { model: 'Qwen-3.5-397B-A17B', hardware: 'b200' },
  { model: 'Qwen-3.5-397B-A17B', hardware: 'h200' },
  { model: 'Qwen-3.5-397B-A17B', hardware: 'mi355x' },
  { model: 'DeepSeek-V4.1-Flash', hardware: 'h200' },
  { model: 'DeepSeek-V4.1-Flash', hardware: 'mi355x' },
  { model: 'DeepSeek-V4.1-Flash', hardware: 'b200' },
  { model: 'DeepSeek-V4-Pro', hardware: 'b300' },
  { model: 'DeepSeek-V4-Pro', hardware: 'gb300' },
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const round = (n, d = 0) => Number(n.toFixed(d));

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) fail(`GET ${url} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload && payload.error) fail(`GET ${url} returned error: ${payload.error}`);
  return payload;
}

/** Benchmark hardware key -> gpu-specs chip entry (prefix match both ways). */
function chipFor(chips, hwKey) {
  return (
    chips.find(c => c.key === hwKey) ||
    chips.find(c => c.key.startsWith(hwKey)) ||
    chips.find(c => hwKey.startsWith(c.key.split('-')[0]))
  );
}

function totalGpus(row) {
  const prefill = Number(row.num_prefill_gpu) || 0;
  const decode = Number(row.num_decode_gpu) || 0;
  // Disaggregated rows count roles independently and should be summed;
  // aggregate engines mirror one count in both columns.
  const gpus = row.disagg ? prefill + decode : decode || prefill;
  return gpus > 0 ? gpus : null;
}

function hitRate(row) {
  const server = Number(row.metrics?.server_gpu_cache_hit_rate);
  if (Number.isFinite(server) && server >= 0) return server;
  const theoretical = Number(row.metrics?.theoretical_cache_hit_rate);
  if (Number.isFinite(theoretical) && theoretical >= 0) return theoretical;
  return null;
}

function eligible(row) {
  const m = row.metrics || {};
  const num = v => Number.isFinite(v) && v > 0;
  return (
    row.benchmark_type === 'agentic_traces' &&
    num(m.input_tput_tps) &&
    num(m.output_tput_tps) &&
    num(m.mean_input_tokens) &&
    num(m.mean_output_tokens_actual) &&
    num(m.median_intvty) &&
    m.median_intvty >= INTERACTIVITY_FLOOR &&
    hitRate(row) !== null &&
    totalGpus(row) !== null
  );
}

function buildPreset(entry, row, hardwareInfo, nodeSize) {
  const m = row.metrics;
  const gpus = totalGpus(row);

  // Topology: full scale-up domains become N nodes; a sub-domain partition
  // (e.g. 24 of 72 NVL72 GPUs) becomes a single node of that size so the
  // fleet cost still equals rental rate x 730 x total GPUs.
  let gpusPerNode;
  let numNodes;
  if (gpus % nodeSize === 0) {
    gpusPerNode = nodeSize;
    numNodes = gpus / nodeSize;
  } else {
    gpusPerNode = gpus;
    numNodes = 1;
  }

  const costPerNode = round(hardwareInfo.costPerHour.r * HOURS_PER_MONTH * gpusPerNode, 2);

  const isl = Math.round(m.mean_input_tokens);
  const osl = Math.round(m.mean_output_tokens_actual);
  const inputTps = Math.round(m.input_tput_tps);
  const outputTps = Math.round(m.output_tput_tps);
  const perUser = round(m.median_intvty, 1);
  const hit = round(hitRate(row) * 100, 1);

  // Same capacity math as the app: prefill goodput is raw (cache hits
  // included), so the prefill limit divides by the input fraction.
  const inputFrac = isl / (isl + osl);
  const outputFrac = osl / (isl + osl);
  const decodeLimit = outputTps / outputFrac;
  const prefillLimit = inputTps / inputFrac;
  const sustained = Math.min(decodeLimit, prefillLimit);

  const hwLabel = hardwareInfo.label;
  const short = `${entry.model} ${hwLabel.replace(/ NVL72| SXM/g, '')}`;
  const islk = Math.round(isl / 1000);
  const oslk = Math.round(osl / 1000);

  return {
    id: `${entry.model}-${entry.hardware}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    label: `${entry.model} · ${hwLabel} · ${islk}k:${oslk}k ISL:OSL, ${hit}% cache`,
    short,
    featured: Boolean(entry.featured),
    source: {
      model: entry.model,
      modelKey: row.model,
      hardware: entry.hardware,
      framework: row.framework,
      precision: row.precision,
      disagg: Boolean(row.disagg),
      concurrency: row.conc,
      date: row.date,
      runUrl: row.run_url,
      gpuHourRate: hardwareInfo.costPerHour.r,
    },
    values: {
      gpuType: hwLabel,
      gpusPerNode,
      numNodes,
      costPerNode,
      concurrency: row.conc,
      cacheHitRate: hit,
      avgIsl: isl,
      avgOsl: osl,
      inputTps,
      outputTps,
      outputTpsPerUser: perUser,
    },
    // Dry-run diagnostics (not written to index.html).
    _sustained: sustained,
    _binding: decodeLimit <= prefillLimit ? 'decode' : 'prefill',
  };
}

function renderBlock(presets, today) {
  const lines = presets.map(p => {
    const src = p.source;
    const v = p.values;
    return [
      `    { id: ${quote(p.id)}, label: ${quote(p.label)}, short: ${quote(p.short)}, featured: ${p.featured ? 'true' : 'false'},`,
      `      source: { model: ${quote(src.model)}, hardware: ${quote(src.hardware)}, framework: ${quote(src.framework)}, precision: ${quote(src.precision)}, disagg: ${src.disagg}, concurrency: ${src.concurrency}, date: ${quote(src.date)}, runUrl: ${quote(src.runUrl)}, gpuHourRate: ${src.gpuHourRate} },`,
      `      values: { gpuType: ${quote(v.gpuType)}, gpusPerNode: ${v.gpusPerNode}, numNodes: ${v.numNodes}, costPerNode: ${v.costPerNode}, concurrency: ${v.concurrency}, cacheHitRate: ${v.cacheHitRate}, avgIsl: ${v.avgIsl}, avgOsl: ${v.avgOsl}, inputTps: ${v.inputTps}, outputTps: ${v.outputTps}, outputTpsPerUser: ${v.outputTpsPerUser} } },`,
    ].join('\n');
  });

  return [
    START_MARKER,
    `  // Snapshot: ${today}`,
    '  // Generated by scripts/refresh-presets.mjs from https://inferencex.semianalysis.com.',
    '  // Each preset is a measured agentic-traces operating point from a single InferenceX',
    '  // benchmark run on a vLLM- or SGLang-family stack (latest date, best throughput',
    '  // meeting an interactivity floor). Demand-estimate inputs are left at the repo defaults.',
    '  const SCENARIO_PRESETS = [',
    ...lines,
    '  ];',
    END_MARKER,
  ].join('\n');
}

function extractBlock(html) {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    fail('index.html is missing the SCENARIO_PRESETS marker block');
  }
  return { start, end: end + END_MARKER.length, text: html.slice(start, end + END_MARKER.length) };
}

function normalizeSnapshot(text) {
  return text.replace(/^  \/\/ Snapshot: .*$/m, '  // Snapshot: YYYY-MM-DD');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write');
  const check = args.has('--check');

  const [options, gpuSpecs] = await Promise.all([
    getJSON(`${API}/api/v1/views/options`),
    getJSON(`${API}/api/v1/views/gpu-specs`),
  ]);

  const hardwareCatalog = new Map(options.hardware.map(h => [h.key, h]));
  const frameworkFamily = new Map(options.frameworks.map(f => [f.key, f.family]));
  const SERVING_FAMILIES = new Set(['vllm', 'sglang']);
  const isSupportedStack = row => SERVING_FAMILIES.has(frameworkFamily.get(row.framework));
  const chips = gpuSpecs.chips || [];

  const modelCache = new Map();
  const rowsFor = async model => {
    if (!modelCache.has(model)) modelCache.set(model, await getJSON(`${API}/api/v1/benchmarks?model=${encodeURIComponent(model)}`));
    const rows = modelCache.get(model);
    if (!Array.isArray(rows)) fail(`unexpected benchmarks response for ${model}`);
    return rows;
  };

  const presets = [];
  for (const entry of CURATED) {
    const hardwareInfo = hardwareCatalog.get(entry.hardware);
    if (!hardwareInfo) fail(`unknown hardware key ${entry.hardware}. Update CURATED in scripts/refresh-presets.mjs.`);

    const rows = (await rowsFor(entry.model)).filter(r => r.hardware === entry.hardware && isSupportedStack(r) && eligible(r));
    if (rows.length === 0) {
      fail(`no valid vLLM/SGLang agentic-traces run for ${entry.model} on ${entry.hardware}. Update CURATED in scripts/refresh-presets.mjs.`);
    }

    rows.sort((a, b) => (b.date > a.date) - (b.date < a.date) || (b.metrics.output_tput_tps || 0) - (a.metrics.output_tput_tps || 0));
    const row = rows[0];

    const chip = chipFor(chips, entry.hardware);
    const nodeSize = Number(chip?.scaleUpWorldSize) || 8;
    presets.push(buildPreset(entry, row, hardwareInfo, nodeSize));
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextBlock = renderBlock(presets, today);

  const html = await readFile(INDEX_PATH, 'utf8');
  const current = extractBlock(html);
  const stale = normalizeSnapshot(current.text) !== normalizeSnapshot(nextBlock);

  console.log(`Scenario preset snapshot (${today})`);
  for (const p of presets) {
    console.log(
      `  ${p.label.padEnd(34)} ${String(p.source.concurrency).padStart(5)} conc  ` +
      `${Math.round(p._sustained).toLocaleString('en-US').padStart(10)} tok/s (${p._binding}-bound)  ` +
      `hit ${String(p.values.cacheHitRate).padStart(4)}%  ${p.source.date}`
    );
  }

  if (check) {
    if (stale) {
      console.error('\nindex.html is stale. Run: node scripts/refresh-presets.mjs --write');
      process.exit(1);
    }
    console.log('\nindex.html is up to date.');
    return;
  }

  if (!stale) {
    console.log('\nNo changes needed.');
    return;
  }

  const nextHtml = html.slice(0, current.start) + nextBlock + html.slice(current.end);

  if (write) {
    await writeFile(INDEX_PATH, nextHtml);
    console.log(`\nUpdated ${path.relative(process.cwd(), INDEX_PATH)}`);
  } else {
    console.log('\nDry run. Re-run with --write to apply. Proposed block:\n');
    console.log(nextBlock);
  }
}

main().catch(error => fail(error.stack || error.message));
