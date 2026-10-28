/** Editors such as xterm own their text outside the browser's input value. */
export interface DictationInsertion {
  unchanged: () => boolean;
  insert: (text: string, spoken?: boolean) => void;
}

const targets = new WeakMap<HTMLElement, () => DictationInsertion>();

export function registerDictationTarget(field: HTMLElement, capture: () => DictationInsertion): () => void {
  targets.set(field, capture);
  return () => { targets.delete(field); };
}

export function dictationTarget(field: HTMLElement) { return targets.get(field); }
