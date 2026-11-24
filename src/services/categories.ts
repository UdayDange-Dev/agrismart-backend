/**
 * Product categories from the ERPNext Item Group tree.
 *
 * Items are usually assigned to deep leaf groups (e.g. "DRIP KIT" under IRRIGATION > DRIP
 * IRRIGATION > DRIP KITS), so the storefront navigates by the top-level groups (children of the
 * root "All Item Groups") and a category filter matches any group on an item's path. If the tree
 * is unavailable (e.g. the API user cannot read Item Group), each item's own group is used.
 */

export interface ItemGroupRow {
  name: string;
  parent: string | null;
}

export interface CategoryCount {
  /** Exact ERPNext Item Group name; used as the identifier in URLs (?category=...). */
  name: string;
  /** Readable display name, e.g. "WATER PUMPS & MOTORS" -> "Water Pumps & Motors". */
  label: string;
  count: number;
}

export interface CategorySummary extends CategoryCount {
  /** Direct sub-groups that contain products. */
  children: CategoryCount[];
}

/** Abbreviations in Agrismart's Item Group names that stay upper case in labels. */
const ACRONYMS = new Set([
  'CI', 'CPVC', 'DOL', 'DU', 'EP', 'FAPT', 'FTA', 'GI', 'HD', 'HDPE', 'HTP', 'ISI', 'LED', 'LW', 'MAPT', 'MCB', 'MCCB',
  'MS', 'MTA', 'NPV', 'NRV', 'PC', 'PCAS', 'PCNL', 'PCJ', 'PE', 'PL', 'PSB', 'PVC', 'KMB', 'RRJ', 'RTB', 'RTM', 'SASD',
  'SKT', 'SS', 'SU', 'TL', 'UPVC', 'VAM', 'WHS',
]);
const MINOR_WORDS = new Set(['AND', 'OF', 'FOR', 'WITH', 'IN', 'ON', 'TO']);

function labelWord(word: string, first: boolean): string {
  if (/[a-z]/.test(word)) return word; // already mixed case (e.g. "uPVC") - keep as entered
  const core = word.replace(/[^A-Z]/g, '');
  if (core.length <= 1 || /[.\d]/.test(word) || ACRONYMS.has(core) || !/[AEIOU]/.test(core)) return word;
  if (!first && MINOR_WORDS.has(word)) return word.toLowerCase();
  return word.replace(/[A-Z]+/, (w) => w[0] + w.slice(1).toLowerCase());
}

/** Readable label for an ERPNext Item Group name. Words already in mixed case are kept as entered. */
export function categoryLabel(name: string): string {
  let first = true;
  return name
    .split(/(\s+|-)/)
    .map((part) => {
      if (/^(\s+|-)$/.test(part) || part === '') return part;
      const out = labelWord(part, first);
      first = false;
      return out;
    })
    .join('');
}

const MAX_DEPTH = 32;

/** Builds a lookup from group name to its path below the root (top-level group first). */
export function groupPaths(groups: ItemGroupRow[]): (group: string) => string[] {
  const parentOf = new Map<string, string | null>();
  for (const g of groups) parentOf.set(g.name, g.parent?.trim() || null);
  const roots = new Set([...parentOf].filter(([, p]) => p === null).map(([n]) => n));
  const memo = new Map<string, string[]>();
  return (group: string) => {
    const cached = memo.get(group);
    if (cached) return cached;
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null = group;
    while (current && !roots.has(current) && !seen.has(current) && path.length < MAX_DEPTH) {
      seen.add(current);
      path.unshift(current);
      // Unknown group (not in the tree): treat it as its own top-level category.
      current = parentOf.has(current) ? (parentOf.get(current) ?? null) : null;
    }
    const result = path.length > 0 ? path : [group];
    memo.set(group, result);
    return result;
  };
}

const byLabel = (a: CategoryCount, b: CategoryCount) => a.label.localeCompare(b.label);

/**
 * Sets each product's category path and summarises the categories for navigation.
 * With the tree: every top-level group is listed (so navigation mirrors ERPNext even before a
 * group has published products), with its non-empty direct sub-groups. Without it: the distinct
 * item groups of the products.
 */
export function buildCategories<P extends { category: string; categoryPath: string[] }>(
  products: P[],
  groups: ItemGroupRow[] | null,
): CategorySummary[] {
  if (!groups || groups.length === 0) {
    const counts = new Map<string, number>();
    for (const p of products) {
      p.categoryPath = [p.category];
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, label: categoryLabel(name), count, children: [] })).sort(byLabel);
  }

  const pathOf = groupPaths(groups);
  const top = new Map<string, { count: number; children: Map<string, number> }>();
  const rootNames = new Set(groups.filter((g) => !g.parent?.trim()).map((g) => g.name));
  for (const g of groups) {
    if (g.parent && rootNames.has(g.parent.trim()) && !rootNames.has(g.name)) top.set(g.name, { count: 0, children: new Map() });
  }
  for (const p of products) {
    p.categoryPath = pathOf(p.category);
    const [head, child] = p.categoryPath;
    const entry = top.get(head!) ?? { count: 0, children: new Map<string, number>() };
    entry.count += 1;
    if (child) entry.children.set(child, (entry.children.get(child) ?? 0) + 1);
    top.set(head!, entry);
  }
  return [...top]
    .map(([name, { count, children }]) => ({
      name,
      label: categoryLabel(name),
      count,
      children: [...children].map(([n, c]) => ({ name: n, label: categoryLabel(n), count: c })).sort(byLabel),
    }))
    .sort(byLabel);
}

/** True if `category` (case-insensitive) is any group on the product's path. */
export function inCategory(product: { categoryPath: string[] }, category: string): boolean {
  const wanted = category.trim().toLowerCase();
  return product.categoryPath.some((g) => g.toLowerCase() === wanted);
}
