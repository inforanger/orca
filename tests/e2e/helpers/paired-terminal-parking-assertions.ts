import type { Page } from '@stablyai/playwright-test'
import {
  capturePairedRetentionHeapSnapshot,
  readPairedRetentionSample,
  type PairedRetentionSample
} from '../paired-runtime-retention-metrics'
import { toHostSessionTabId } from '../../../src/shared/terminal-surface-id'
import { expect, test } from './orca-app'

export async function diagnosePairedRetentionGrowth(
  page: Page,
  tabIds: string[],
  baseline: PairedRetentionSample,
  after: PairedRetentionSample,
  budgetBytes: number
): Promise<void> {
  if (after.heapBytes <= baseline.heapBytes + budgetBytes) {
    return
  }
  const samples = [after]
  for (const delayMs of [100, 250, 500, 1_000]) {
    await page.waitForTimeout(delayMs)
    samples.push(await readPairedRetentionSample(page, tabIds))
  }
  await test.info().attach('paired-retention-failure-samples', {
    body: JSON.stringify({ baseline, samples }, null, 2),
    contentType: 'application/json'
  })
  await test.info().attach('paired-retention.heapsnapshot', {
    body: await capturePairedRetentionHeapSnapshot(page),
    contentType: 'application/json'
  })
}

export async function expectHostTerminalsUnmounted(
  hostPage: Page | undefined,
  activeWorktreeId: string,
  remoteTabs: { tabId: string }[]
): Promise<void> {
  if (!hostPage) {
    return
  }
  await expect
    .poll(
      () =>
        hostPage.evaluate(
          (tabIds) => ({
            activeWorktreeId: window.__store?.getState().activeWorktreeId,
            mountedCount: tabIds.filter((tabId) => window.__paneManagers?.has(tabId)).length
          }),
          remoteTabs.map(({ tabId }) => toHostSessionTabId(tabId))
        ),
      { timeout: 30_000 }
    )
    .toEqual({ activeWorktreeId, mountedCount: 0 })
}
