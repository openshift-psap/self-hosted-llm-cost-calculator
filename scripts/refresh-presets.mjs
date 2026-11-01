#!/usr/bin/env node
/**
 * Refresh the scenario preset snapshot in index.html from the InferenceX API.
 *
 * For each curated (model, hardware) pair below, picks an operating point
 * from that configuration's Pareto curve of agentic-traces runs on a vLLM-
 * or SGLang-family serving stack: the highest-throughput frontier point
 * whose median per-user interactivity still meets a 35 tok/s target.
 *
 *   - total goodput    = total_tput_tps          (input + output tokens/s,
 *                          cache hits included — used directly as capacity)
 *   - cache hit rate    = server_gpu_cache_hit_rate (measured, same run)
 *   - ISL / OSL         = mean_input_tokens / mean_output_tokens_actual
 *   - tok/s per user    = median_intvty
 *   - $/node/month      = rental $/GPU-hr x 730 x GPUs per node
 *
 * Demand-estimate inputs (users, sessions/day, calls/session, working days)
 * are deliberately NOT set by presets — they retain the user's values.
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const API = 'https://inferencex.semianalysis.com';

const START_MARKER = '  // BEGIN SCENARIO_PRESETS';
const END_MARKER = '  // END SCENARIO_PRESETS';

/** Minimum median interactivity (tok/s per session) for a usable preset. */
const INTERACTIVITY_FLOOR = 20;
/**
 * Per-user interactivity target for operating-point selection. Among the
 * Pareto frontier of a model's runs, the preset takes the highest-throughput
 * point whose median interactivity still meets this target (InferenceX's own
 * calculator defaults to the same number).
 */
const INTERACTIVITY_TARGET = 35;
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
  throw new Error(message);
}

const round = (n, d = 0) => Number(n.toFixed(d));

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
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

export function nodeSizeFor(chips, hardwareInfo) {
  const size = chipFor(chips, hardwareInfo.key)?.scaleUpWorldSize;
  if (Number.isInteger(size) && size > 0) return size;
  // The chip catalog can lag the hardware catalog. NVL labels explicitly
  // identify the scale-up domain. TPU7x retains the calculator's explicit
  // eight-chip accounting unit until its topology is in the chip catalog.
  const nvl = hardwareInfo.label.match(/\bNVL(\d+)\b/);
  if (nvl && Number(nvl[1]) > 0) return Number(nvl[1]);
  if (hardwareInfo.key === 'tpuv7') return 8;
  fail(`missing node topology for ${hardwareInfo.key}; update the explicit topology mapping`);
}

export function totalGpus(row) {
  const prefill = Number(row.num_prefill_gpu) || 0;
  const decode = Number(row.num_decode_gpu) || 0;
  // Disaggregated rows count roles independently and should be summed;
  // aggregate engines mirror one count in both columns.
  const gpus = row.disagg ? prefill + decode : decode || prefill;
  return Number.isInteger(gpus) && gpus > 0 ? gpus : null;
}

export function hitRate(row) {
  const server = row.metrics?.server_gpu_cache_hit_rate;
  return Number.isFinite(server) && server >= 0 && server <= 1 ? server : null;
}

export function eligible(row) {
  const m = row.metrics || {};
  const num = v => Number.isFinite(v) && v > 0;
  return (
    row.benchmark_type === 'agentic_traces' &&
    Number.isInteger(row.conc) && row.conc > 0 &&
    num(m.total_tput_tps) &&
    num(m.mean_input_tokens) &&
    num(m.mean_output_tokens_actual) &&
    num(m.median_intvty) &&
    m.median_intvty >= INTERACTIVITY_FLOOR &&
    hitRate(row) !== null &&
    totalGpus(row) !== null
  );
}

export function buildPreset(entry, row, hardwareInfo, nodeSize) {
  const m = row.metrics;
  const gpus = totalGpus(row);
  if (!eligible(row)) fail('cannot build a preset from an ineligible benchmark');
  if (!Number.isInteger(nodeSize) || nodeSize <= 0) fail('invalid node size');
  if (!Number.isFinite(hardwareInfo.costPerHour?.r) || hardwareInfo.costPerHour.r < 0) fail('missing rental price');

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
  const totalGoodput = Math.round(m.total_tput_tps);
  const perUser = round(m.median_intvty, 1);
  const hit = round(hitRate(row) * 100, 1);

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
      totalGoodput,
      outputTpsPerUser: perUser,
    },
  };
}

/**
 * Pareto frontier of runs on the (total throughput, interactivity) plane.
 * A point is kept unless another point matches or beats it on both axes and
 * strictly beats it on at least one.
 */
export function paretoFrontier(rows) {
  const pts = rows.map(r => ({ row: r, t: r.metrics.total_tput_tps, i: r.metrics.median_intvty }));
  return pts
    .filter(a => !pts.some(b => b !== a && b.t >= a.t && b.i >= a.i && (b.t > a.t || b.i > a.i)))
    .map(p => p.row);
}

/** Pick the operating point: max-throughput frontier point meeting the
 *  interactivity target; if the whole frontier is slower than the target,
 *  fall back to the most interactive frontier point. Newest date breaks ties. */
export function pickOperatingPoint(rows) {
  const frontier = paretoFrontier(rows);
  const onTarget = frontier.filter(r => r.metrics.median_intvty >= INTERACTIVITY_TARGET);
  const pool = onTarget.length ? onTarget : frontier;
  const primary = onTarget.length ? 'total_tput_tps' : 'median_intvty';
  return pool.sort(
    (a, b) =>
      (b.metrics[primary] - a.metrics[primary]) ||
      ((b.date > a.date) - (a.date > b.date))
  )[0];
}

function renderBlock(presets, today) {
  const lines = presets.map(p => {
    const src = p.source;
    const v = p.values;
    return [
      `    { id: ${quote(p.id)}, label: ${quote(p.label)}, short: ${quote(p.short)}, featured: ${p.featured ? 'true' : 'false'},`,
      `      source: { model: ${quote(src.model)}, hardware: ${quote(src.hardware)}, framework: ${quote(src.framework)}, precision: ${quote(src.precision)}, disagg: ${src.disagg}, concurrency: ${src.concurrency}, date: ${quote(src.date)}, runUrl: ${quote(src.runUrl)}, gpuHourRate: ${src.gpuHourRate} },`,
      `      values: { gpuType: ${quote(v.gpuType)}, gpusPerNode: ${v.gpusPerNode}, numNodes: ${v.numNodes}, costPerNode: ${v.costPerNode}, concurrency: ${v.concurrency}, cacheHitRate: ${v.cacheHitRate}, avgIsl: ${v.avgIsl}, avgOsl: ${v.avgOsl}, totalGoodput: ${v.totalGoodput}, outputTpsPerUser: ${v.outputTpsPerUser} } },`,
    ].join('\n');
  });

  return [
    START_MARKER,
    `  // Snapshot: ${today}`,
    '  // Generated by scripts/refresh-presets.mjs from https://inferencex.semianalysis.com.',
    '  // Each preset is a measured agentic-traces operating point from a single InferenceX',
    '  // benchmark run on a vLLM- or SGLang-family stack. Selection: the highest-throughput',
    '  // Pareto frontier point meeting a 35 tok/s per-user interactivity target.',
    '  // Demand-estimate inputs retain the user\'s current values.',
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

    const row = pickOperatingPoint(rows);

    const nodeSize = nodeSizeFor(chips, hardwareInfo);
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
      `  ${p.label.padEnd(50)} ${String(p.source.concurrency).padStart(5)} conc  ` +
      `${p.values.totalGoodput.toLocaleString('en-US').padStart(11)} tok/s  ` +
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
