import { test, expect } from '@playwright/test';

const baseUrl = String(process.env.ASSET_MANAGER_E2E_URL || '').replace(/\/$/, '');

async function isAssetManagerFrame(frame) {
  try {
    if (frame === frame.page().mainFrame()) return false;
    const body = await frame.locator('body').innerText().catch(() => '');
    return body.includes('Asset Manager') && body.includes('Configuration');
  } catch {
    return false;
  }
}

async function waitForAppFrame(page) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await isAssetManagerFrame(frame)) return frame.url() || 'found';
    }
    return '';
  }, { timeout: 30_000 }).not.toBe('');

  for (const frame of page.frames()) {
    if (await isAssetManagerFrame(frame)) return frame;
  }
  throw new Error('Asset Manager iframe did not render.');
}

async function waitForReportsFrame(page) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const body = (await frame.locator('body').innerText().catch(() => '')).toLowerCase();
      if (body.includes('report') && !body.includes('asset manager could not load')) return frame.url() || 'found';
    }
    return '';
  }, { timeout: 30_000 }).not.toBe('');

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const body = (await frame.locator('body').innerText().catch(() => '')).toLowerCase();
    if (body.includes('report') && !body.includes('asset manager could not load')) return frame;
  }
  throw new Error('Reports iframe did not render.');
}

async function assertAppHealthy(frame) {
  const body = await frame.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(30);
  expect(body).not.toContain('Asset Manager could not load');
  expect(body).not.toContain('locationMapping is not defined');
  expect(body).not.toContain('There was an error invoking the function - Limits for the current installation have been exceeded');
}

async function clickSidebar(page, name) {
  let frame = await waitForAppFrame(page);
  const sidebar = frame.locator('.nv-sidebar');
  await expect(sidebar).toBeVisible({ timeout: 10_000 });
  const target = sidebar.getByText(name, { exact: true });
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
  await target.first().click({ force: true });
  await page.waitForTimeout(700);
  frame = await waitForAppFrame(page);
  await assertAppHealthy(frame);
  return frame;
}

test.describe('Asset Manager sandbox browser acceptance', () => {
  test.skip(!baseUrl, 'ASSET_MANAGER_E2E_URL is not configured.');

  test('overview, assets, import modal and configuration render without runtime errors', async ({ page }) => {
    await page.goto(`${baseUrl}/overview`, { waitUntil: 'domcontentloaded' });
    let frame = await waitForAppFrame(page);
    await assertAppHealthy(frame);

    frame = await clickSidebar(page, 'Assets');
    expect(await frame.locator('body').innerText()).toContain('Assets');

    const importButton = frame.getByRole('button', { name: 'Import', exact: true });
    await expect(importButton).toBeVisible({ timeout: 10_000 });
    await importButton.click();
    await expect(frame.getByRole('heading', { name: 'Import assets', exact: true })).toBeVisible({ timeout: 10_000 });
    await assertAppHealthy(frame);

    const closeButton = frame.getByRole('button', { name: 'Close', exact: true });
    if (await closeButton.count()) await closeButton.click();
    else await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(300);

    frame = await clickSidebar(page, 'Configuration');
    const configBody = await frame.locator('body').innerText();
    expect(configBody).toContain('Configuration');
  });

  test('reports route renders without Forge/runtime failure', async ({ page }) => {
    await page.goto(`${baseUrl}/reports`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForReportsFrame(page);
    await assertAppHealthy(frame);
    const body = await frame.locator('body').innerText();
    expect(body.toLowerCase()).toContain('report');
  });
});
