// Enum Roblox generique : Enum.X.Y renvoie toujours le meme objet { Name, Value, EnumType }.
const types = new Map<string, any>()
const items = new Map<string, any>()

function itemOf(typeName: string, name: string) {
  const key = typeName + '.' + name
  let it = items.get(key)
  if (!it) {
    it = { Name: name, Value: items.size, EnumType: undefined as any, toString: () => `Enum.${typeName}.${name}` }
    items.set(key, it)
  }
  return it
}

function typeOf(typeName: string) {
  let t = types.get(typeName)
  if (!t) {
    const base: any = { __enum: typeName, GetEnumItems: () => [...items.entries()].filter(([k]) => k.startsWith(typeName + '.')).map(([, v]) => v) }
    t = new Proxy(base, {
      get(target, p) {
        if (typeof p === 'symbol' || p in target) return target[p as any]
        const it = itemOf(typeName, p)
        it.EnumType = t
        return it
      },
    })
    types.set(typeName, t)
  }
  return t
}

export const Enum: any = new Proxy(
  {},
  {
    get(_t, p) {
      if (typeof p === 'symbol') return undefined
      return typeOf(p)
    },
  },
)
