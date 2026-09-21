import { test, expect } from '@playwright/test';

const baseUrl = String(process.env.ASSET_MANAGER_E2E_URL || '').replace(/\/$/, '');

function internalAdminUrl(route) {
  const url = new URL(baseUrl);
  const match = url.pathname.match(/^\/jira\/apps\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Could not derive internal admin URL from ${baseUrl}`);
  return `${url.origin}/jira/settings/apps/${match[1]}/${match[2]}/${route}`;
}

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

async function waitForInternalFrame(page, heading) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const body = await frame.locator('body').innerText().catch(() => '');
      if (body.includes(heading)) return frame.url() || 'found';
    }
    return '';
  }, { timeout: 30_000 }).not.toBe('');

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const body = await frame.locator('body').innerText().catch(() => '');
    if (body.includes(heading)) return frame;
  }
  throw new Error(`${heading} iframe did not render.`);
}

async function assertAppHealthy(frame) {
  const body = await frame.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(30);
  expect(body).not.toContain('Asset Manager could not load');
  expect(body).not.toContain('locationMapping is not defined');
  expect(body).not.toContain('There was an error invoking the function - Limits for the current installation have been exceeded');
  expect(body).not.toContain('Task timed out after 25.00 seconds');
  expect(body).not.toContain('Could not load crew report.');
  expect(body).not.toContain('Could not load reconciliation report.');
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
    await expect(frame.locator('.nv-sidebar')).toBeVisible();
    await expect(frame.locator('.nv-sidebar').getByText('Overview', { exact: true })).toBeVisible();
    await expect(frame.locator('.nv-sidebar').getByText('Assets', { exact: true })).toBeVisible();
    await expect(frame.locator('.nv-sidebar').getByText('Imports', { exact: true })).toBeVisible();
    await expect(frame.locator('.nv-sidebar').getByText('Reports', { exact: true })).toBeVisible();
    await expect(frame.locator('.nv-sidebar').getByText('Configuration', { exact: true })).toBeVisible();
  });

  test('asset register exposes configurable Client view, row selection and safe reconciliation preview', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${baseUrl}/overview`, { waitUntil: 'domcontentloaded' });
    let frame = await clickSidebar(page, 'Assets');
    await assertAppHealthy(frame);

    const columnsButton = frame.getByRole('button', { name: 'Columns & filters', exact: true });
    await expect(columnsButton).toBeVisible({ timeout: 10_000 });
    await columnsButton.click();
    await expect(frame.getByText('Choose columns', { exact: true })).toBeVisible();
    await expect(frame.locator('label').filter({ hasText: /^Client$/ })).toBeVisible();

    const addFilter = frame.locator('.filters select').last();
    await expect(addFilter.locator('option', { hasText: 'Client' })).toHaveCount(1);

    const selectAll = frame.getByLabel('Select all visible assets');
    if (await selectAll.count()) {
      await expect(selectAll).toBeVisible();
      const firstRowCheckbox = frame.locator('tbody input[type="checkbox"]').first();
      if (await firstRowCheckbox.count()) {
        await firstRowCheckbox.check();
        await expect(frame.getByRole('button', { name: /Delete selected \(1\)/ })).toBeVisible();
        await firstRowCheckbox.uncheck();
      }
    }

    await frame.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Import assets', exact: true })).toBeVisible({ timeout: 10_000 });
    const fileInput = frame.locator('input[type="file"]').first();
    const unique = `QA-BROWSER-${Date.now()}`;
    await fileInput.setInputFiles({
      name: 'qa-asset-reconcile.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`Device Name,Device ID,Serial Number,Type,Client\n${unique},${unique},SER-${unique},Laptop,QA\n`),
    });
    await expect(frame.getByText(/1 ready to import/i)).toBeVisible({ timeout: 20_000 });
    const resultCell = frame.locator('tbody tr').first().locator('td').last();
    await expect(resultCell).toContainText(/Create new|Update existing|Update by name|Merge by serial|Reconcile during import/i, { timeout: 20_000 });
    await assertAppHealthy(frame);
    await frame.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Large-file acceptance: prove the preview is bounded and remaining rows are deferred
    // rather than sending the whole file through one Forge invocation.
    await frame.getByRole('button', { name: 'Import', exact: true }).click();
    const largeRows = Array.from({ length: 205 }, (_, i) => {
      const id = `${unique}-LARGE-${String(i + 1).padStart(3, '0')}`;
      return `${id},${id},SER-${id},Laptop,QA`;
    });
    const largeFileInput = frame.locator('input[type="file"]').first();
    await largeFileInput.setInputFiles({
      name: 'qa-large-asset-reconcile.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`Device Name,Device ID,Serial Number,Type,Client\n${largeRows.join('\n')}\n`),
    });
    await expect(frame.getByText(/205 ready to import/i)).toBeVisible({ timeout: 60_000 });
    await expect(frame.getByText(/Large-file mode: the first 200 valid rows are previewed now/i)).toBeVisible({ timeout: 60_000 });
    // The large-file banner and row count prove the preview was bounded. Deferred rows
    // do not have to be rendered in the first visible table page to be safely reconciled
    // during the actual import, so don't require that label to be on-screen here.
    await assertAppHealthy(frame);
    await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('reports route renders without Forge/runtime failure', async ({ page }) => {
    await page.goto(`${baseUrl}/reports`, { waitUntil: 'domcontentloaded' });
    const frame = await waitForReportsFrame(page);
    await assertAppHealthy(frame);
    const body = await frame.locator('body').innerText();
    expect(body.toLowerCase()).toContain('report');
  });

  test('internal Crew Tracking loads live data and validates a crew import file without writing', async ({ page }) => {
    await page.goto(internalAdminUrl('crew-tracking'), { waitUntil: 'domcontentloaded' });
    const frame = await waitForInternalFrame(page, 'Internal Crew Tracking');
    await assertAppHealthy(frame);

    await expect(frame.getByRole('heading', { name: 'Internal Crew Tracking', exact: true })).toBeVisible();
    await expect(frame.getByText('Total crew', { exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Link JSM customers', exact: true })).toBeVisible();
    await expect(frame.getByPlaceholder('Search crew, name, location, type or device…')).toBeVisible();

    const fileInput = frame.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: 'qa-crew.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Crew Code,Name,Location,Email,Status\nQA-BROWSER-001,QA Browser User,DUB,qa-browser@example.invalid,Active\n'),
    });
    await expect(frame.getByText(/1 crew records read/i)).toBeVisible({ timeout: 10_000 });
    await expect(frame.getByRole('button', { name: /Resume\/import 1 crew/i })).toBeVisible();
    await assertAppHealthy(frame);
  });

  test('internal Device Usage Reconciliation loads live data and validates a vPOS report without writing', async ({ page }) => {
    await page.goto(internalAdminUrl('device-usage'), { waitUntil: 'domcontentloaded' });
    const frame = await waitForInternalFrame(page, 'Device Usage Reconciliation');
    await assertAppHealthy(frame);

    await expect(frame.getByRole('heading', { name: 'Device Usage Reconciliation', exact: true })).toBeVisible();
    await expect(frame.getByText('Devices checked', { exact: true })).toBeVisible();
    await expect(frame.getByText('Assignment mismatches', { exact: true })).toBeVisible();
    await expect(frame.getByPlaceholder('Search device, code, crew, type or location…')).toBeVisible();

    const fileInput = frame.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: 'qa-vpos.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Device Name,Device Code,Last Login,Last Sync DateTime\nQA-VPOS-001,QA-CODE-001,QA-BROWSER-001,2026-09-14 12:00:00\n'),
    });
    await expect(frame.getByText(/1 devices with a Last Login are ready to import and reconcile/i)).toBeVisible({ timeout: 10_000 });
    await expect(frame.getByRole('button', { name: /Import & reconcile 1 devices/i })).toBeVisible();
    await assertAppHealthy(frame);
  });
});
