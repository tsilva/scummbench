// ScummWEB backbone catalog slugs are launch identifiers. W&B projects use ScummVM's
// gameId, which differs from edition-specific launcher targets such as
// dreamweb-cd and monkey-demo. These mappings follow ScummWEB's games catalog.
const catalogIds = new Map([
  ['beneath-a-steel-sky', 'sky'],
  ['broken-sword-2-5-the-return-of-the-templars', 'sword25'],
  ['drascula-the-vampire-strikes-back', 'drascula'],
  ['dreamweb', 'dreamweb'],
  ['flight-of-the-amazon-queen', 'queen'],
  ['lure-of-the-temptress', 'lure'],
  ['nippon-safes-inc', 'nippon'],
  ['the-secret-of-monkey-island-demo', 'monkey'],
]);

export function scummvmGameId(game) {
  if (catalogIds.has(game)) return catalogIds.get(game);
  return [...catalogIds.values()].includes(game) ? game : null;
}

export const scummvmGameIds = Object.freeze([...new Set(catalogIds.values())].sort());
