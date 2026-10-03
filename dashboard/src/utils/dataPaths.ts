// Where data files live. A docket site reads everything from ./data/. A scoped-analysis sub-site
// (<docket>/scopes/<slug>/) has its own small ./data/ (meta, scope, themes, summaries, extracts,
// overview, in-scope units) and reads the docket's large shared files (comment index, detail and
// text shards, search index, entities, campaigns) from meta.sharedData, e.g. ../../data/.
let shared = './data/'

export function setSharedDataBase(base: string | undefined) {
  shared = base ? (base.endsWith('/') ? base : base + '/') : './data/'
}

// A file this site publishes itself
export const ownData = (path: string) => `./data/${path}`

// A file that a scope sub-site shares with its docket (same as ownData on a docket site)
export const sharedData = (path: string) => `${shared}${path}`
