import { test, expect } from '@playwright/test';

const baseUrl = String(process.env.ASSET_MANAGER_E2E_URL || '').replace(/\/$/, '');

async function waitForAppFrame(page) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.getByText('Asset Manager', { exact: true }).count()) return frame.url() || 'found';
      } catch {}
    }
    return '';
  }, { timeout: 25_000 }).not.toBe('');

  for (const frame of page.frames()) {
    try {
      if (await frame.getByText('Asset Manager', { exact: true }).count()) return frame;
    } catch {}
  }
  throw new Error('Asset Manager iframe did not render.');
}

async function assertAppHealthy(frame) {
  const body = await frame.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(30);
  expect(body).not.toContain('Asset Manager could not load');
  expect(body).not.toContain('locationMapping is not defined');
  expect(body).not.toContain('There was an error invoking the function - Limits for the current installation have been exceeded');
}

async function clickNav(frame, name) {
  const button = frame.getByRole('button', { name, exact: true });
  if (await button.count()) return button.first().click();
  const link = frame.getByRole('link', { name, exact: true });
  if (await link.count()) return link.first().click();
  return frame.getByText(name, { exact: true }).first().click();
}

test.describe('Asset Manager sandbox browser acceptance', () => {
  test.skip(!baseUrl, 'ASSET_MANAGER_E2E_URL is not configured.');

  test('overview and internal navigation render without runtime errors', async ({ page }) => {
    await page.goto(`${baseUrl}/overview`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForAppFrame(page);
    await assertAppHealthy(frame);

    for (const section of ['Assets', 'Imports', 'Configuration']) {
      await clickNav(frame, section);
      await frame.waitForTimeout(500);
      await assertAppHealthy(frame);
    }
  });

  test('reports route renders without Forge/runtime failure', async ({ page }) => {
    await page.goto(`${baseUrl}/reports`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForAppFrame(page);
    await assertAppHealthy(frame);
    const body = await frame.locator('body').innerText();
    expect(body.toLowerCase()).toContain('report');
  });
});
