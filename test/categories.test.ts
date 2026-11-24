import { describe, expect, it } from 'vitest';
import { buildCategories, categoryLabel, groupPaths, inCategory } from '../src/services/categories.js';

describe('category labels', () => {
  it('makes upper-case ERPNext group names readable without mangling abbreviations', () => {
    expect(categoryLabel('WATER PUMPS & MOTORS')).toBe('Water Pumps & Motors');
    expect(categoryLabel('ELECTRICAL & CONTROL')).toBe('Electrical & Control');
    expect(categoryLabel('PVC BALL VALVES - DU')).toBe('PVC Ball Valves - DU');
    expect(categoryLabel('G.I MATERIAL')).toBe('G.I Material');
    expect(categoryLabel('FABRICATED TAIL PIECE WITH FLANGE')).toBe('Fabricated Tail Piece with Flange');
    expect(categoryLabel('ELBOW 45° HD')).toBe('Elbow 45° HD');
    expect(categoryLabel('MYCORRHIZA (VAM)')).toBe('Mycorrhiza (VAM)');
    expect(categoryLabel('J-TURBO KEY PLUS')).toBe('J-Turbo Key Plus');
    expect(categoryLabel('uPVC FITTING')).toBe('uPVC Fitting');
    expect(categoryLabel('Seeds')).toBe('Seeds');
  });
});

describe('Item Group paths', () => {
  const groups = [
    { name: 'All Item Groups', parent: null },
    { name: 'IRRIGATION', parent: 'All Item Groups' },
    { name: 'DRIP IRRIGATION', parent: 'IRRIGATION' },
    { name: 'DRIP KIT', parent: 'DRIP IRRIGATION' },
    { name: 'LOOP A', parent: 'LOOP B' },
    { name: 'LOOP B', parent: 'LOOP A' },
  ];

  it('returns the path below the root, top-level first', () => {
    const pathOf = groupPaths(groups);
    expect(pathOf('DRIP KIT')).toEqual(['IRRIGATION', 'DRIP IRRIGATION', 'DRIP KIT']);
    expect(pathOf('IRRIGATION')).toEqual(['IRRIGATION']);
  });

  it('treats unknown groups as top-level and survives cycles in bad data', () => {
    const pathOf = groupPaths(groups);
    expect(pathOf('NOT IN TREE')).toEqual(['NOT IN TREE']);
    expect(pathOf('LOOP A')).toEqual(['LOOP B', 'LOOP A']);
  });

  it('summarises top-level groups (including empty ones) and matches whole subtrees', () => {
    const products = [{ category: 'DRIP KIT', categoryPath: [] as string[] }];
    const cats = buildCategories(products, groups);
    expect(cats.find((c) => c.name === 'IRRIGATION')).toEqual({
      name: 'IRRIGATION',
      label: 'Irrigation',
      count: 1,
      children: [{ name: 'DRIP IRRIGATION', label: 'Drip Irrigation', count: 1 }],
    });
    expect(inCategory(products[0]!, 'irrigation')).toBe(true);
    expect(inCategory(products[0]!, 'DRIP')).toBe(false);
  });
});
