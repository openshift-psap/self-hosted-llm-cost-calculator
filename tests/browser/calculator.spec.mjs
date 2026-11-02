import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const chartJs = await readFile(new URL('../../node_modules/chart.js/dist/chart.umd.js', import.meta.url), 'utf8');
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:4173/')) return route.continue();
    if (url.includes('chart.umd.min.js')) return route.fulfill({ contentType: 'application/javascript', body: chartJs });
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.startsWith('https://fonts.gstatic.com/')) return route.abort();
    if (url.includes('openrouter.ai/api/v1/models')) return route.fulfill({ json: { data: [] } });
    if (url.includes('huggingface.co/api/models')) return route.fulfill({ json: [{ id: 'test/reference-model', downloads: 1000 }] });
    throw new Error(`Unexpected external request: ${url}`);
  });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

test('pricing controls are keyboard accessible and update real chart/table data', async ({ page }) => {
  await page.goto('/');
  const expand = page.getByRole('button', { name: /^Edit prices for/ }).first();
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#price-0-cachedPrice').fill('0.2');
  await page.locator('#price-0-outputPrice').fill('20');
  await page.locator('#price-0-inputPrice').fill('9');
  await expect(page.locator('#blended-0')).toHaveText('$0.96/M');
  expect(await page.evaluate(() => Chart.getChart(document.querySelector('#costChart')).data.datasets[1].data[0].y)).toBeCloseTo(0.9559345462926216, 10);
  await page.locator('.frontier-list input[type="checkbox"]').first().uncheck();
  await expect(page.locator('#breakevenBody tr')).toHaveCount(4);
  const toggle = page.getByRole('button', { name: 'Show derivation' });
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#mathToggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mathExplanation')).toBeVisible();
});

test('invalid inputs and capacity limits cannot masquerade as feasible costs', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cache hit rate (%)', { exact: true }).fill('200');
  await expect(page.locator('#inputErrors')).toContainText('between 0 and 100');
  await expect(page.locator('#shCostAtUtil')).toHaveText('N/A');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(0);
  await expect(page.locator('.chart-canvas-holder')).toBeHidden();
  await page.locator('#cacheHitRate').fill('87');
  await expect(page.locator('.chart-canvas-holder')).toBeVisible();
  await page.locator('#totalGoodput').fill('0');
  await expect(page.locator('#derivedUtil')).toContainText('no capacity');
  await expect(page.locator('#shCostPerM')).toHaveText('N/A');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
  await page.locator('#totalGoodput').fill('96000');
  await page.locator('#sessionsPerDay').fill('10');
  await expect(page.locator('#derivedUtil')).toHaveText('684.6% (exceeds capacity)');
  await expect(page.locator('#shCostAtUtil')).toContainText('insufficient capacity');
  const annotations = await page.evaluate(() => {
    const chart = Chart.getChart(document.querySelector('#costChart'));
    const labels = [];
    const original = chart.ctx.fillText;
    chart.ctx.fillText = function(text, ...args) { labels.push(text); return original.call(this, text, ...args); };
    chart.stop(); chart.update('none');
    chart.ctx.fillText = original;
    return labels;
  });
  expect(annotations.some(text => String(text).startsWith('Capacity limit: 100%'))).toBe(true);
  expect(annotations.some(text => String(text).startsWith('Your scenario: 684'))).toBe(false);
});

test('native PDF printing builds a fresh report and captures a rendered chart', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.pdf({ path: testInfo.outputPath('first-report.pdf'), printBackground: true });
  await expect(page.locator('#printContent h1')).toHaveText('GLM-5.2, B200, 155k:1k ISL:OSL, 92.8% cache');
  await expect(page.locator('#printContent')).toContainText('Monthly API bill at estimated demand');
  expect(await page.locator('#printContent img').getAttribute('src')).toMatch(/^data:image\/png;base64,.{100,}/);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#printContent')).toBeVisible();
  await expect(page.locator('#printContent img')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#gpuType').fill('H200');
  await page.locator('#numUsers').fill('0');
  await page.pdf({ path: testInfo.outputPath('updated-report.pdf') });
  await expect(page.locator('#printContent h1')).toHaveText('GLM-5.2 on H200');
  await expect(page.locator('#printContent')).toContainText('N/A/M tokens');
  await expect(page.locator('#printContent')).toContainText('0.0B tokens/month');
});

test('API and CDN failures leave numerical output and printing usable', async ({ page }) => {
  await page.route('**/api/v1/models', route => route.abort());
  await page.route('**/chart.umd.min.js', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#frontierLoading')).toContainText('unavailable');
  await expect(page.locator('#chartStatus')).toContainText('Chart unavailable');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
  await page.locator('#numUsers').fill('400');
  await expect(page.locator('#monthlyDemand')).toHaveText('345.7B tokens/month');
  await page.getByRole('button', { name: 'Print report', exact: true }).click();
  await expect(page.locator('#printContent')).toContainText('Chart unavailable');
  await expect(page.locator('#printContent tbody tr')).not.toHaveCount(0);
});

test('pending requests show immediate snapshot results and time out visibly', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/v1/models', () => {});
  await page.goto('/');
  await expect(page.locator('#annualTco')).toHaveText('$259,296');
  await expect(page.locator('#frontierLoading')).toContainText('checking OpenRouter');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
  await page.clock.fastForward(8100);
  await expect(page.locator('#frontierLoading')).toContainText('unavailable');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
});

test('mobile header controls fit the viewport and visible inputs have accessible names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const selector of ['#presetQuick', '#presetSelect', '#btnPrint']) {
    const box = await page.locator(selector).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const controls = page.getByRole('spinbutton');
  expect(await controls.count()).toBeGreaterThan(10);
  for (const control of await controls.all()) await expect(control).toHaveAccessibleName(/.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('frontier pricing lives in the desktop rail and stacks below 1320px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page).toHaveTitle('Self-Hosted vs Frontier API Cost Comparison');
  await expect(page.locator('h1')).toHaveText('Self-Hosted vs Frontier API Cost Comparison');
  const wide = await page.evaluate(() => {
    const aside = document.querySelector('.frontier-aside');
    const main = document.querySelector('.main');
    const sidebar = document.querySelector('.sidebar');
    return {
      inMain: main.contains(aside),
      inSidebar: sidebar.contains(aside),
      top: Math.round(aside.getBoundingClientRect().top),
      columns: getComputedStyle(main).gridTemplateColumns.split(' ').length,
      firstModelVisible: Boolean(document.querySelector('.frontier-list input[type="checkbox"]')),
    };
  });
  expect(wide.inMain).toBe(true);
  expect(wide.inSidebar).toBe(false);
  expect(wide.top).toBeLessThan(200);
  expect(wide.columns).toBe(2);
  expect(wide.firstModelVisible).toBe(true);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.main')).gridTemplateColumns.split(' ').length)).toBe(1);
});

test('log scale toggle reconfigures the y-axis and preserves annotations', async ({ page }) => {
  await page.goto('/');
  const scale = () => page.evaluate(() => {
    const chart = Chart.getChart(document.querySelector('#costChart'));
    return { type: chart.scales.y.type, min: chart.scales.y.min, max: chart.scales.y.max };
  });
  expect((await scale()).type).toBe('linear');
  await page.getByLabel('Log scale').check();
  await expect.poll(async () => (await scale()).type).toBe('logarithmic');
  const log = await scale();
  expect(log.min).toBeGreaterThan(0);
  expect(log.max).toBeGreaterThan(log.min);
  const labels = await page.evaluate(() => {
    const chart = Chart.getChart(document.querySelector('#costChart'));
    const out = [];
    const original = chart.ctx.fillText;
    chart.ctx.fillText = function(text, ...args) { out.push(text); return original.call(this, text, ...args); };
    chart.stop(); chart.update('none');
    chart.ctx.fillText = original;
    return out;
  });
  expect(labels.some(text => String(text).startsWith('Your scenario'))).toBe(true);
  await page.getByLabel('Log scale').uncheck();
  await expect.poll(async () => (await scale()).type).toBe('linear');
});

test('at-a-glance verdict summarizes the comparison and reacts to demand', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#verdictText')).toContainText('below every enabled frontier API');
  await expect(page.locator('#verdictSelfHosted')).not.toHaveText('—');
  await expect(page.locator('#verdictBestApi')).toContainText('/M');
  await page.locator('#numUsers').fill('20');
  await expect(page.locator('#verdictText')).toContainText('is less expensive');
  await page.locator('#numUsers').fill('0');
  await expect(page.locator('#verdictText')).toContainText('demand is zero');
  await expect(page.locator('#verdictSelfHosted')).toHaveText('N/A');
});

test('preset provenance follows benchmark edits, and model search supports keyboard selection', async ({ page }) => {
  await page.goto('/');
  await page.locator('#presetQuick button').first().click();
  await expect(page.locator('#presetProvenance')).toBeVisible();
  const presetValue = await page.locator('#presetSelect').inputValue();
  expect(presetValue).toMatch(/^\d+$/);
  await page.locator('#numUsers').fill('300');
  await expect(page.locator('#presetSelect')).toHaveValue(presetValue);
  await page.locator('#totalGoodput').fill('1000');
  await expect(page.locator('#presetSelect')).toHaveValue('custom');
  await expect(page.locator('#presetProvenance')).toBeHidden();
  await page.getByLabel('Model', { exact: true }).fill('reference');
  const result = page.getByRole('button', { name: /test\/reference-model/ });
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#hfSearch')).toHaveValue('test/reference-model');
});
