export function createAsyncSemaphore() {
  let locked = false
  const waiters: Array<() => void> = []

  async function acquire() {
    if (locked) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    } else {
      locked = true
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next()
      else locked = false
    }
  }

  return {
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const release = await acquire()
      try {
        return await operation()
      } finally {
        release()
      }
    },
  }
}

export const interviewOcrProviderSemaphore = createAsyncSemaphore()
