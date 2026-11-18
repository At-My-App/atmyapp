
import { mergeVariantOverlay } from '../src/variantMerge';

describe('mergeVariantOverlay', () => {
  it('deep-merges plain objects field by field', () => {
    expect(
      mergeVariantOverlay(
        { title: 'Hello', seo: { description: 'Base', keywords: 'a,b' } },
        { seo: { description: 'Localized' } }
      )
    ).toEqual({
      title: 'Hello',
      seo: { description: 'Localized', keywords: 'a,b' },
    });
  });

  it('replaces scalars and adds overlay-only fields', () => {
    expect(
      mergeVariantOverlay({ title: 'Hello' }, { title: 'Witaj', extra: true })
    ).toEqual({ title: 'Witaj', extra: true });
  });

  it('merges arrays by identity field and keeps base order', () => {
    expect(
      mergeVariantOverlay(
        [
          { id: 'a', label: 'One', kept: true },
          { id: 'b', label: 'Two' },
        ],
        [{ id: 'b', label: 'Dwa' }]
      )
    ).toEqual([
      { id: 'a', label: 'One', kept: true },
      { id: 'b', label: 'Dwa' },
    ]);
  });

  it('appends overlay array items without a base match', () => {
    expect(
      mergeVariantOverlay(
        [{ id: 'a', label: 'One' }],
        [{ id: 'z', label: 'New' }]
      )
    ).toEqual([
      { id: 'a', label: 'One' },
      { id: 'z', label: 'New' },
    ]);
  });

  it('replaces arrays wholesale when no identity field is found', () => {
    expect(mergeVariantOverlay(['one', 'two'], ['jeden'])).toEqual(['jeden']);
  });

  it('returns the overlay when types do not line up', () => {
    expect(mergeVariantOverlay({ a: 1 }, 'text')).toBe('text');
  });
  it('keeps keyed translations attached through source reorder and drops removed source items', () => {
    const overlay = [
      { _key: 'a', label: 'Jeden' },
      { _key: 'b', label: 'Dwa' },
    ];
    expect(
      mergeVariantOverlay(
        [
          { _key: 'b', label: 'Two' },
          { _key: 'a', label: 'One' },
        ],
        overlay
      )
    ).toEqual([
      { _key: 'b', label: 'Dwa' },
      { _key: 'a', label: 'Jeden' },
    ]);
    expect(mergeVariantOverlay([{ _key: 'b', label: 'Two' }], overlay)).toEqual(
      [{ _key: 'b', label: 'Dwa' }]
    );
    expect(mergeVariantOverlay(undefined, overlay)).toEqual([]);
    expect(mergeVariantOverlay({}, { items: overlay })).toEqual({ items: [] });
    expect(mergeVariantOverlay({}, { section: { items: overlay } })).toEqual({
      section: { items: [] },
    });
  });
});
