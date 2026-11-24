export class Janitor {
  private items = new Map<any, { obj: any; method?: string }>()
  private n = 0
  Add<T>(obj: T, method?: any, index?: any): T {
    this.items.set(index ?? ++this.n, { obj, method: typeof method === 'string' ? method : undefined })
    return obj
  }
  AddPromise<T>(p: T) { return this.Add(p) }
  Get(i: any) { return this.items.get(i)?.obj }
  Remove(i: any) { const it = this.items.get(i); if (it) { this.clean(it); this.items.delete(i) } return this }
  private clean({ obj, method }: { obj: any; method?: string }) {
    try {
      if (method && obj?.[method]) obj[method]()
      else if (typeof obj === 'function') obj()
      else if (obj?.Disconnect) obj.Disconnect()
      else if (obj?.Destroy) obj.Destroy()
      else if (obj?.destroy) obj.destroy()
      else if (obj?.cancel) obj.cancel()
    } catch (e) { console.error('[janitor]', e) }
  }
  Cleanup() { const all = [...this.items.values()]; this.items.clear(); for (const it of all.reverse()) this.clean(it) }
  Destroy() { this.Cleanup() }
  LinkToInstance(inst: any) { const c = inst.Destroying.Connect(() => this.Cleanup()); return c }
}
export default Janitor
