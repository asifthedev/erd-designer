/**
 * English singular / plural for identifiers, used to follow Prisma's naming convention: models are singular
 * (`User`), while lists of them are plural (`users`). Table names come in either form (`users`, `user`), so both
 * directions are needed. Conservative on purpose: a word that isn't clearly a regular plural is left alone, because
 * a wrong guess (`status` -> `statu`) is worse than an unchanged name.
 */

/** Same form singular and plural, or ending in "s" without being a plural. Never changed. */
const UNCHANGED = new Set(
  (
    'news series species data media metadata information equipment staff sheep fish deer money rice ' +
    'canvas atlas alias bias gas lens status bonus campus virus census corpus focus bus plus ' +
    'analysis basis axis crisis diagnosis thesis hypothesis emphasis synopsis'
  ).split(' '),
)

const IRREGULAR_PLURAL: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice',
  goose: 'geese',
  foot: 'feet',
  tooth: 'teeth',
  quiz: 'quizzes',
}
const IRREGULAR_SINGULAR = Object.fromEntries(Object.entries(IRREGULAR_PLURAL).map(([s, p]) => [p, s]))

/** Plurals that look like "-ies" but whose singular ends in "-ie". */
const IE_WORDS = new Set(['movie', 'cookie', 'selfie', 'zombie', 'pie', 'tie', 'lie', 'rookie', 'smoothie', 'genie'])
/** Singulars that end in "s" and take "-es" for the plural. */
const ES_STEMS = ['status', 'bus', 'bonus', 'campus', 'virus', 'alias', 'atlas', 'census', 'corpus', 'focus']

function singularWord(word: string): string {
  const w = word.toLowerCase()
  if (UNCHANGED.has(w)) return word
  if (IRREGULAR_SINGULAR[w]) return IRREGULAR_SINGULAR[w]
  if (ES_STEMS.some((s) => w === `${s}es`)) return w.slice(0, -2)
  if (w.endsWith('ies') && w.length > 4) {
    return IE_WORDS.has(w.slice(0, -1)) ? w.slice(0, -1) : `${w.slice(0, -3)}y` // categories -> category, movies -> movie
  }
  if (/(sses|ches|shes|xes)$/.test(w)) return w.slice(0, -2) // addresses, branches, dishes, boxes
  // Plain "-s": users -> user. Not "ss" (address), "us" (menu is fine, status handled above), "is" (analysis).
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w) && w.length > 2) return w.slice(0, -1)
  return word
}

function pluralWord(word: string): string {
  const w = word.toLowerCase()
  if (UNCHANGED.has(w) && !ES_STEMS.includes(w)) return word
  if (IRREGULAR_PLURAL[w]) return IRREGULAR_PLURAL[w]
  if (singularWord(word) !== word) return word // already looks plural: users, categories, addresses
  if (ES_STEMS.includes(w)) return `${w}es`
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies` // category -> categories
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es` // address -> addresses, box -> boxes
  return `${w}s`
}

/** Keep the first letter's case: the caller works on `Items` as often as on `items`. */
const withCase = (original: string, result: string) =>
  original[0] === original[0]?.toUpperCase() && original[0] !== original[0]?.toLowerCase()
    ? result[0].toUpperCase() + result.slice(1)
    : result

/** Applies `fn` to the last word of an identifier (`order_items` -> `items`, `orderItems` -> `Items`). */
function onLastWord(input: string, fn: (word: string) => string): string {
  const match = /([A-Z]?[a-z0-9]+|[A-Z]+)$/.exec(input)
  if (!match) return input
  return input.slice(0, match.index) + withCase(match[0], fn(match[0]))
}

/** `blog_posts` -> `blog_post`, `categories` -> `category`, `status` -> `status`. */
export const singularizeName = (input: string) => onLastWord(input, singularWord)

/** `blogPost` -> `blogPosts`, `category` -> `categories`, `users` -> `users` (already plural). */
export const pluralizeName = (input: string) => onLastWord(input, pluralWord)
