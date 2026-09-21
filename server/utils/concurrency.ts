export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}
