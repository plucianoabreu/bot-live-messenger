import type { RuntimeOptions } from './types';
type WelcomePreferenceOptions = Pick<RuntimeOptions,'live'|'userId'>;
type WelcomeStorage = Pick<Storage,'getItem'|'setItem'>;
type WelcomeDocumentOptions = Pick<RuntimeOptions,'live'|'runsEnabled'> & {watchAvailable?:boolean};
export const welcomePreferenceKey: (userId:string)=>string;
export function readWelcomePreference(storage:WelcomeStorage,options:WelcomePreferenceOptions):boolean;
export function writeWelcomePreference(storage:WelcomeStorage,options:WelcomePreferenceOptions,open:boolean):void;
export function welcomeDocumentState(options?:WelcomeDocumentOptions):{mode:'live'|'demo';disclosure:string;guide:string};
export function welcomeMenuState(options?:{selectionStart?:number;selectionEnd?:number;wrap?:boolean;fontSize?:number}):{canCopy:boolean;wrapChecked:boolean;canIncreaseFont:boolean;canDecreaseFont:boolean;defaultFont:boolean};
export function createDesktopShortcutSelection(ids:readonly string[]):{select(id:string):string|null;isSelected(id:string):boolean;current():string|null};
export function prepareV1Markup(markup:string):string;
export function prepareWelcomeMarkup(markup:string,live?:boolean):string;
export function mountMessenger(host: HTMLElement, options: RuntimeOptions): {update(options:RuntimeOptions):void;destroy():void};

export function initialAuthMode(options?:Pick<RuntimeOptions,'recovery'>):'login'|'signup';
