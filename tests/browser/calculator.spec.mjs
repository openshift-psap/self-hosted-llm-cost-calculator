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
  await expect(page.locator('#blended-0')).toHaveText('$2.51/M');
  expect(await page.evaluate(() => Chart.getChart(document.querySelector('#costChart')).data.datasets[1].data[0])).toBeCloseTo(2.51, 10);
  await page.getByRole('checkbox').first().uncheck();
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
  await page.locator('#cacheHitRate').fill('87');
  await page.locator('#totalGoodput').fill('0');
  await expect(page.locator('#derivedUtil')).toContainText('no capacity');
  await expect(page.locator('#shCostPerM')).toHaveText('N/A');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
  await page.locator('#totalGoodput').fill('96000');
  await page.locator('#sessionsPerDay').fill('10');
  await expect(page.locator('#derivedUtil')).toHaveText('140.2% — exceeds capacity');
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
  expect(annotations.some(text => String(text).startsWith('Your scenario: 100'))).toBe(false);
});

test('native PDF printing builds a fresh report and captures a rendered chart', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Scenario name', { exact: true }).fill('First report');
  await page.pdf({ path: testInfo.outputPath('first-report.pdf'), printBackground: true });
  await expect(page.locator('#printContent h1')).toHaveText('First report');
  await expect(page.locator('#printContent')).toContainText('Monthly API Bill at Estimated Demand');
  expect(await page.locator('#printContent img').getAttribute('src')).toMatch(/^data:image\/png;base64,.{100,}/);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#printContent')).toBeVisible();
  await expect(page.locator('#printContent img')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.getByLabel('Scenario name', { exact: true }).fill('Updated report');
  await page.locator('#numUsers').fill('0');
  await page.pdf({ path: testInfo.outputPath('updated-report.pdf') });
  await expect(page.locator('#printContent h1')).toHaveText('Updated report');
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
  await expect(page.locator('#monthlyDemand')).toHaveText('70.8B tokens/month');
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(page.locator('#printContent')).toContainText('Chart unavailable');
  await expect(page.locator('#printContent tbody tr')).not.toHaveCount(0);
});

test('pending requests show immediate snapshot results and time out visibly', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/v1/models', () => {});
  await page.goto('/');
  await expect(page.locator('#annualTco')).toHaveText('$1,113,393');
  await expect(page.locator('#frontierLoading')).toContainText('checking OpenRouter');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
  await page.clock.fastForward(8100);
  await expect(page.locator('#frontierLoading')).toContainText('unavailable');
  await expect(page.locator('#breakevenBody tr')).toHaveCount(5);
});

test('mobile header controls fit the viewport and visible inputs have accessible names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const selector of ['#scenarioName', '#scenarioDesc', '#btnPrint']) {
    const box = await page.locator(selector).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const controls = page.getByRole('spinbutton');
  expect(await controls.count()).toBeGreaterThan(10);
  for (const control of await controls.all()) await expect(control).toHaveAccessibleName(/.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('preset provenance follows benchmark edits, and model search supports keyboard selection', async ({ page }) => {
  await page.goto('/');
  await page.locator('#presetQuick button').first().click();
  await expect(page.locator('#presetProvenance')).toBeVisible();
  await page.locator('#numUsers').fill('300');
  await expect(page.locator('#presetSelect')).toHaveValue('0');
  await page.locator('#totalGoodput').fill('1000');
  await expect(page.locator('#presetSelect')).toHaveValue('custom');
  await expect(page.locator('#presetProvenance')).toBeHidden();
  await page.getByLabel('Model (search HuggingFace)', { exact: true }).fill('reference');
  const result = page.getByRole('button', { name: /test\/reference-model/ });
  await result.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#hfSearch')).toHaveValue('test/reference-model');
});
