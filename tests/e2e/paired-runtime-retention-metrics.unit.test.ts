import type { Page } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPairedRetentionSample } from './paired-runtime-retention-metrics'

afterEach(() => vi.unstubAllGlobals())

function fixture(failingMethod?: string) {
  const calls: string[] = []
  let usedSize = 1_000
  const session = {
    send: async (method: string) => {
      calls.push(method)
      if (method === failingMethod) throw new Error(`failed ${method}`)
      return { usedSize }
    },
    detach: async () => {
      calls.push('detach')
    }
  }
  vi.stubGlobal('window', {
    __paneManagers: new Map([
      ['target', { getPanes: () => [{ terminal: { cols: 80, buffer: { active: { length: 20 } } } }] }],
      ['unrelated', { getPanes: () => [{ terminal: { cols: 80, buffer: { active: { length: 999 } } } }] }]
    ])
  })
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    evaluate: async (callback: (ids: string[]) => unknown, ids: string[]) => callback(ids)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every Page operation used by this sampler.
  } as unknown as Page
  return {
    page,
    calls,
    setHeap: (bytes: number) => {
      usedSize = bytes
    }
  }
}

describe('paired terminal retention measurements', () => {
  it('reads a fresh heap directly from CDP after each garbage collection', async () => {
    const f = fixture()
    const baseline = await readPairedRetentionSample(f.page, ['target', 'parked'])
    f.setHeap(500)
    const after = await readPairedRetentionSample(f.page, ['target', 'parked'])
    expect(baseline).toEqual({
      heapBytes: 1_000,
      bufferCells: 1_600,
      mountedTargetManagers: 1,
      targetPanes: 1
    })
    expect(after.heapBytes).toBe(500)
    expect(f.calls).toEqual([
      'HeapProfiler.collectGarbage',
      'Runtime.getHeapUsage',
      'detach',
      'HeapProfiler.collectGarbage',
      'Runtime.getHeapUsage',
      'detach'
    ])
  })

  it('does not hide retained heap growth', async () => {
    const f = fixture()
    const baseline = await readPairedRetentionSample(f.page, [])
    f.setHeap(baseline.heapBytes + 32 * 1024 * 1024)
    const after = await readPairedRetentionSample(f.page, [])
    expect(after.heapBytes).toBeGreaterThan(baseline.heapBytes + 16 * 1024 * 1024)
  })

  it.each(['HeapProfiler.collectGarbage', 'Runtime.getHeapUsage'])(
    'fails closed and detaches when %s fails',
    async (method) => {
      const f = fixture(method)
      await expect(readPairedRetentionSample(f.page, [])).rejects.toThrow(`failed ${method}`)
      expect(f.calls.at(-1)).toBe('detach')
    }
  )
})
