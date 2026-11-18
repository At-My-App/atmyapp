import { getSubmissionVisit } from '../src/client/submissionVisit';

function browser(href: string, referrer = '', storage = new Map<string, string>(), blocked = false): Window {
  const doc = { referrer };
  Object.defineProperty(doc, 'cookie', { get() { throw new Error('Cookies forbidden'); }, set() { throw new Error('Cookies forbidden'); } });
  return { location: new URL(href), document: doc,
    sessionStorage: { getItem: (key: string) => { if (blocked) throw new Error('Blocked'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error('Blocked'); storage.set(key, value); } },
  } as unknown as Window;
}

describe('cookie-free current-visit attribution', () => {
  afterEach(() => jest.restoreAllMocks());
  it('preserves a Google Ads arrival while browsing without keeping click IDs or query strings', () => {
    const storage = new Map<string, string>();
    const landing = browser('https://site.test/offer?gclid=private&utm_campaign=Autumn', 'https://google.com/search?q=secret', storage);
    expect(getSubmissionVisit(landing)).toMatchObject({ source: 'ads.google.com', campaign: 'Autumn', landingPage: 'https://site.test/offer' });
    const contact = browser('https://site.test/contact?email=private', 'https://site.test/offer', storage);
    expect(getSubmissionVisit(contact)).toMatchObject({ source: 'ads.google.com', landingPage: 'https://site.test/offer', page: 'https://site.test/contact' });
    expect([...storage.values()].join()).not.toMatch(/gclid|private|secret|email/);
  });
  it('expires after 30 minutes of inactivity, including restored tabs', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    const storage = new Map<string, string>();
    const first = browser('https://site.test/offer?gclid=x', '', storage);
    getSubmissionVisit(first);
    now.mockReturnValue(1_000_000_000 + 31 * 60_000);
    expect(getSubmissionVisit(browser('https://site.test/contact', 'https://site.test/offer', storage)))
      .toMatchObject({ source: null, landingPage: 'https://site.test/contact' });
  });
  it('starts a new visit on an external arrival, without overwriting internal navigation', () => {
    const storage = new Map<string, string>();
    getSubmissionVisit(browser('https://site.test/', 'https://google.com', storage));
    expect(getSubmissionVisit(browser('https://site.test/new', 'https://instagram.com', storage)))
      .toMatchObject({ source: 'instagram.com', landingPage: 'https://site.test/new' });
  });
  it('uses memory if storage is blocked and works without a browser', () => {
    const win = browser('https://site.test/?via=flyer', '', new Map(), true);
    expect(getSubmissionVisit(win)?.source).toBe('link:flyer');
    expect(getSubmissionVisit(undefined)).toBeNull();
  });
  it('does not capture preview visits', () => {
    expect(getSubmissionVisit(browser('https://site.test/?amaPreviewKey=secret'))).toBeNull();
  });
});
