import { Signal as BaseSignal } from '../rbx/signal'

// @rbxts/signal : Signal<T> avec Connect / Once / Fire / Wait / Destroy.
export class Signal<T extends any[] = any[]> extends BaseSignal<T> {
  Destroy() { this.DisconnectAll() }
  DisconnectAll() { super.DisconnectAll() }
}
export default Signal
