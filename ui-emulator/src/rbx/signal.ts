export interface Connection {
  Connected: boolean
  Disconnect(): void
}

let syncSignalWaits = 0

export class Signal<A extends any[] = any[]> {
  private hs = new Set<(...a: A) => void>()

  Connect(fn: (...a: A) => void): Connection {
    this.hs.add(fn)
    const c: Connection = {
      Connected: true,
      Disconnect: () => {
        c.Connected = false
        this.hs.delete(fn)
      },
    }
    return c
  }

  Once(fn: (...a: A) => void): Connection {
    const c = this.Connect((...a: A) => {
      c.Disconnect()
      fn(...a)
    })
    return c
  }

  Wait(): Promise<A> {
    // meme protection que task.wait : une boucle qui appelle Wait() sans `await` est coupee au lieu de figer la page
    if (++syncSignalWaits > 5000) throw new Error('Signal.Wait appele en boucle sans suspension (fonction non convertie en async)')
    queueMicrotask(() => { syncSignalWaits = 0 })
    return new Promise((res) => this.Once((...a: A) => res(a)))
  }

  Fire(...a: A) {
    for (const h of [...this.hs]) {
      try {
        h(...a)
      } catch (e) {
        console.error('[signal handler]', e)
      }
    }
  }

  DisconnectAll() {
    this.hs.clear()
  }
}
