export const MODEL_TEXT: Record<string, { label: string; hint: string }> = {
  'parakeet-v3-ptbr': { label: 'Parakeet v3 PT-BR', hint: 'Ajustado para o português do Brasil.' },
  'parakeet-v3': { label: 'Parakeet v3 multilíngue', hint: 'O original, para 25 idiomas.' },
  'parakeet-v3-int8': {
    label: 'Parakeet v3 multilíngue compacto',
    hint: 'O original reduzido a 8 bits: ocupa menos memória e só roda no processador.',
  },
};

export function modelLabel(name: string): string {
  return MODEL_TEXT[name]?.label ?? name;
}

/**
 * A person's name as the screen shows it: first and last name, capitalized.
 * What is stored and exported keeps the name as the meeting gave it.
 */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const kept = words.length > 2 ? [words[0], words[words.length - 1]] : words;
  return kept.map((w) => w.toLocaleLowerCase('pt-BR').replace(/(^|[-'’])\p{L}/gu, (c) => c.toLocaleUpperCase('pt-BR'))).join(' ');
}

/** The name on screen, saying which one is the local user once the meeting has named them. */
export function shownName(name: string, mine: boolean): string {
  const short = shortName(name);
  return mine && short !== 'Você' ? `${short} (Você)` : short;
}

export function comma(n: number, digits: number): string {
  return n.toFixed(digits).replace('.', ',');
}

export function size(bytes: number): string {
  return bytes >= 1e9 ? `${comma(bytes / 1e9, 1)} GB` : `${comma(bytes / 1e6, 0)} MB`;
}

/** Memory sizes as the hardware is sold: 6 GB, not 6,4 GB of 1000³. */
export function memory(bytes: number): string {
  const gib = bytes / 2 ** 30;
  return gib >= 1 ? `${comma(gib, gib < 10 && Math.abs(gib - Math.round(gib)) > 0.05 ? 1 : 0)} GB` : `${comma(bytes / 2 ** 20, 0)} MB`;
}
