// Objet "tolerant" : repond a tout (propriete, methode, evenement, iteration) sans jamais planter et sans rien enregistrer.
// C'est la reponse de WaitForChild() pour les parties du jeu que l'emulateur ne rend pas (carte 3D, modeles, dossiers de paquets) :
// dans Roblox WaitForChild ne renvoie jamais nil, donc le code ne verifie rien ensuite ; on l'ignore simplement.
// Les recherches (FindFirstChild...) restent fideles : "introuvable" = undefined, le code gere deja ce cas.
export function stub(path: string): any {
  const f: any = function () {}
  return new Proxy(f, {
    get(_t, p) {
      if (p === Symbol.iterator) return function* () {}
      if (p === Symbol.toPrimitive) return () => 0
      if (typeof p === 'symbol' || p === 'then') return undefined
      switch (p) {
        case 'Connect':
        case 'Once':
          return () => ({ Connected: true, Disconnect() {} })
        case 'Wait':
          return () => []
        case 'GetChildren':
        case 'GetDescendants':
          return () => []
        case 'IsA':
        case 'IsDescendantOf':
        case 'IsAncestorOf':
          return () => false
        case 'FindFirstChild':
        case 'FindFirstChildOfClass':
        case 'FindFirstChildWhichIsA':
        case 'FindFirstAncestor':
        case 'FindFirstAncestorOfClass':
        case 'FindFirstAncestorWhichIsA':
        case 'GetAttribute':
          return () => undefined
        case 'WaitForChild':
          return (name: string) => stub(`${path}.${name}`)
        case 'Name':
          return path.slice(path.lastIndexOf('.') + 1)
        case 'toString':
          return () => path
      }
      return stub(`${path}.${String(p)}`)
    },
    apply() { return stub(`${path}()`) },
    set() { return true },
  })
}
