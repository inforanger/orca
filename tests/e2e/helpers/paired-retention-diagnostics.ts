import type { Page } from '@stablyai/playwright-test'
import {
  capturePairedRetentionHeapSnapshot,
  readPairedRetentionSample,
  type PairedRetentionSample
} from '../paired-runtime-retention-metrics'
import { test } from './orca-app'

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
