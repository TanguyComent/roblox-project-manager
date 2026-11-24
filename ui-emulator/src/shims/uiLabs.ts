// Descripteurs de controles UI Labs (le panneau de controles de l'emulateur les lit).
export const Number = (Default = 0, Min?: number, Max?: number, Step?: number) => ({ ControlType: 'Number', Default, Min, Max, Step })
export const Slider = Number
export const Boolean = (Default = false) => ({ ControlType: 'Boolean', Default })
export const String = (Default = '') => ({ ControlType: 'String', Default })
export const Choose = (Options: any[], DefaultIndex = 0) => ({ ControlType: 'Choose', Options, Default: Options[DefaultIndex] })
export const Color3 = (Default: any) => ({ ControlType: 'Color3', Default })
export const InferProps = undefined
export const CreateReactStory = (_libs: any, fn: any) => fn
