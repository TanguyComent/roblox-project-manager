import { ghost } from '../rbx/services'

// Decorateurs Flamework : sans effet dans l'emulateur.
const deco = () => (target: any) => target
export const Controller = deco
export const Service = deco
export const Reflect = ghost('Reflect')
export const Dependency = (): any => ghost('Dependency')
export const Flamework: any = ghost('Flamework')
