/*
 * NovelHall — JavaScript source, prose, English.
 *
 * Added for one reason: **Ascendance of a Bookworm is 677 chapters here**, the
 * whole web edition, where FreeWebNovel stops at 216 (volume 7 part 1). Re:Zero
 * Kara Hajimeru Isekai Seikatsu is 870 and Mushoku Tensei is 285. All three are
 * findable by their English titles, and the whole chapter list of each arrives
 * in **one request** — the series page carries it, so there is no pagination to
 * walk and no private endpoint to depend on.
 *
 * It is its own engine rather than a manifest line on FreeWebNovel's because
 * nothing about the markup is shared: listings are table rows, prose is
 * `<br>`-separated inside one container, and chapter URLs are numeric ids.
 *
 * Nine things about the site shape this file, every one measured live on
 * 2026-09-17 through the app's own client (the site 403s `curl`, so nothing
 * here was learned from a script):
 *
 *  - **Paragraphs are separated by `<br><br>` and are not wrapped in anything.**
 *    `div#htmlContent` holds the whole chapter as one run of text with breaks
 *    between paragraphs, so a `<p>` read finds nothing at all: a chapter that
 *    exists, loads, and arrives empty. The markup is split on the breaks and
 *    each piece is a page. This is the one difference that earns a separate
 *    file.
 *
 *  - **A chapter's URL is a numeric id, not its number**, and the *labels* are
 *    not trustworthy either. Bookworm's list runs "Chapter 1", "Chapter 2",
 *    "Chapter Three", "Chapter Four" — ten rows spell the number out — and four
 *    more go *backwards* (92, 90, 88, 85) because the site mislabelled them. A
 *    number lifted from the label leaves the reader's chapter list
 *    non-monotonic, which sorts it into nonsense and makes tracker progress
 *    move backwards. Position in the site's own list is used instead, and the
 *    numeric ids confirm that order: they rise strictly, 1006904 → 1007704
 *    across all 675 rows.
 *
 *  - **A chapter can live under a different slug from its novel.** Re:Zero's
 *    series page is `/rezero-kara-hajimeru-isekai-seikatsu-26650/` and its
 *    newest chapters are under `/rezero-kara-hajimeru-isekai-seikatsu-wn-26650/`
 *    — same book, two slugs, one id. Scoping the chapter list by slug the way a
 *    normal scrape would drops 300 chapters off the end of the longest novel on
 *    the site. Everything here is scoped by the **id**.
 *
 *  - **A series page carries three lists in identical markup.** "The Newest
 *    Chapter" (nine rows, newest first) above, `div#morelist` (the real list,
 *    oldest first) in the middle, and "Recommended Reading" below, which links
 *    *other novels*. An unscoped read puts chapter 677 where chapter one
 *    belongs, repeats nine rows, and files four other people's novels as
 *    chapters of this one.
 *
 *  - **The listing pager is dead markup and it lies.** Every ranking page ships
 *    its pager commented out, pointing at `/allvisit-2.html` — which answers
 *    404. The pagination that works is the listing's own stem with `-N`:
 *    `/ranking-2.html` and `/ranking-40.html` both return twenty fresh rows.
 *    So no pager is read anywhere in this file; the page number is built, and
 *    the end of a listing is "the page returned nothing".
 *
 *  - **Search is a query the site does not advertise**, `/index.php` with
 *    `s=so&module=book&keyword=…`, and it is accurate: "Ascendance of a
 *    Bookworm" returns exactly one row. A route it doesn't recognise —
 *    `/search-keyword-x.html`, which its own `robots.txt` names — answers
 *    **HTTP 200 with the homepage**, whose "Latest Release Novel" block is a
 *    table of twenty rows in the same markup as a result list. Read as results
 *    that is twenty unrelated novels for every query, and on the import screen
 *    it is worse: a book the user owns gets matched against whatever the site
 *    posted this morning. A search page states so in its own `<title>` and
 *    carries no `<h3>` heading where every listing has one; anything else
 *    throws.
 *
 *  - **A scattered "P" is not a paragraph.** The machine translation leaves a
 *    bare capital P between paragraphs — twelve of them in the 272 of Bookworm
 *    chapter 677 — and each one would be a page of the reader showing a single
 *    letter. Dropped as the artifact it is, while one-word dialogue ("Mine",
 *    "Help") is kept, because that really is the text.
 *
 *  - **Some novels repeat the chapter title as the first paragraph and some
 *    don't.** Re:Zero does, Bookworm doesn't, and the repeat is not an exact
 *    copy — the heading writes `'The Wishes…` where the prose writes `“The
 *    Wishes…`. Compared with the punctuation removed, so the reader doesn't get
 *    a first page holding only the title it just tapped.
 *
 *  - **The blurb the site shows is the truncated one.** `span.js-open-wrap` is
 *    the visible two sentences ending "more>>" and `span.js-close-wrap` is the
 *    whole thing, hidden behind `display:none` until the reader expands it. The
 *    hidden one is the one worth having, which is the opposite of the usual
 *    rule about hidden text.
 *
 * ── Covers, deliberately ────────────────────────────────────────────────────
 *
 * **No listing on this site carries cover art, and neither does search.** They
 * are table rows of titles; the art exists only on a novel's own page. Fetching
 * it for a shelf would be one request per row — twenty per listing — so shelves
 * show `MangaCover`'s gradient placeholder, the same as Dynasty's. What is
 * checked instead is the cover of a novel the reader *opened*, which is the one
 * the app puts on the title screen and in the library, and which the live test
 * fetches the way a grid cell does.
 *
 * ── What a manifest may set (`host.options`, all values are strings) ─────────
 *
 *   popularPath   listing stem for the popular shelf, default "ranking"
 *   latestPath    listing stem for the latest shelf, default "lastupdate"
 *   searchPath    where a query goes, default "/index.php"
 *   searchParams  the fixed part of a search query, default "s=so&module=book"
 *   searchField   the field the query itself goes in, default "keyword"
 *
 * No selectors here, deliberately: `HTMLSelector` degrades silently, so a
 * mistyped one in a manifest gives wrong rows rather than an error.
 */

// A listing page holds twenty rows. The app reads "twenty came back" as
// "there is more", which is right — the ranking runs to 1,685 pages.
var LISTING_PAGE_SIZE = 20;

var SELECTORS = {
  // Every listing and the search results use one table in `div.section3`.
  // Scoped to it because the homepage — which a bad search route returns —
  // carries a second table of recommendations above its own.
  row: 'div.section3 table tr',
  rowLink: 'a',
  // A listing page has a heading over its table ("Power Ranking", "Latest
  // Release"). A search results page has none, which is what tells the two
  // apart when the site substitutes one for the other.
  listingHeading: 'div.section3 h3',

  detailTitle: 'div.book-info h1',
  detailCover: 'div.book-img img',
  // The mobile layout repeats the cover inside the blurb. Read as the fallback
  // for a page served without the desktop block.
  detailCoverAlt: 'div.intro img',
  detailGenre: 'div.total a',
  // The whole blurb, which the site hides until the reader expands it.
  detailSummaryFull: 'span.js-close-wrap',
  detailSummary: 'div.intro',

  // The real chapter list. See the header note about the other two.
  chapterList: 'div#morelist',
  chapterRow: 'li a',
  // Only for a page served without `#morelist`: every chapter link on the page,
  // which needs sorting by id because it picks up "The Newest Chapter" too.
  chapterFallback: 'div.book-catalog li a',

  prose: 'div#htmlContent',
  chapterHeading: 'div.single-header h1'
};

// MARK: - Manifest options

function option(key, fallback) {
  var value = (typeof host !== 'undefined' && host.options) ? host.options[key] : null;
  if (value === undefined || value === null) return fallback;
  value = String(value).trim();
  return value ? value : fallback;
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/**
 * `/ranking.html` for page one, `/ranking-3.html` after that.
 *
 * Built rather than read out of the page's own pager, which is commented out
 * and points at a path that 404s. See the header note.
 */
function listingUrl(stem, page) {
  var clean = String(stem || '').replace(/^\/+/, '').replace(/\.html$/i, '');
  var n = pageNumber(page);
  return host.baseUrl + '/' + clean + (n === 1 ? '' : '-' + n) + '.html';
}

// MARK: - Addresses

/**
 * The novel path in a link, or '' if the link is not one.
 *
 * A novel is one path segment ending in its numeric id — `/martial-master-16537/`.
 * Three other things in a row look similar and none of them is a novel: a genre
 * (`/genre/fantasy20223/`), the author (`href="javascript:"`), and the newest
 * chapter (`/martial-master-16537/1007704.html`, two segments). Storing a
 * chapter URL as a novel is the failure AGENTS.md records for cover anchors —
 * a shelf cell that looks right and opens empty.
 */
function novelPath(href) {
  var raw = String(href || '');
  if (!raw) return '';
  raw = raw.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  if (raw.indexOf('/genre/') === 0) return '';
  var slug = host.regex.first('^\\/([^\\/]+-\\d+)\\/?$', '', raw);
  return slug ? '/' + slug + '/' : '';
}

/**
 * A novel's numeric id, which is the only stable thing about it.
 *
 * Re:Zero's chapters are split across two slugs sharing one id, so the id — not
 * the slug — is what says whether a chapter belongs to this novel.
 */
function bookId(path) {
  return host.regex.first('-(\\d+)\\/?$', '', String(path || '')) || '';
}

/** Whether a link is a chapter of the novel with this id. */
function chapterPath(href, id) {
  var raw = String(href || '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  if (!id) return '';
  var found = host.regex.first('^\\/([^\\/]*-' + id + ')\\/(\\d+)\\.html$', '', raw);
  return found ? raw : '';
}

/** The id inside a chapter's own URL. Rises with chapter order on this site. */
function chapterSequence(url) {
  var n = parseInt(host.regex.first('\\/(\\d+)\\.html$', '', String(url || '')), 10);
  return isNaN(n) ? 0 : n;
}

// MARK: - Listings and search

/**
 * One row of a listing or a search result.
 *
 * The novel's anchor is the first one in the row that is a novel address; the
 * cells before it are the rank number and, on a search page, the genre. The
 * anchor's own text is the title — there are no badges in these headings, and
 * `title` is absent — but it is trimmed, because the site indents its markup
 * inside the anchor.
 */
function entryFrom(row) {
  var links = row.select(SELECTORS.rowLink);
  for (var i = 0; i < links.length; i++) {
    var path = novelPath(links[i].attr('href'));
    if (!path) continue;
    var title = String(links[i].attr('title') || '').trim() || links[i].text().trim();
    title = title.replace(/\s+/g, ' ');
    if (!title) continue;
    // No `thumbnailUrl`: nothing on this site's listings carries one, and an
    // empty string would read as a cover that failed rather than one that was
    // never there. See the header note.
    return { url: path, title: title };
  }
  return null;
}

function rowsIn(doc) {
  var rows = doc.select(SELECTORS.row);
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var entry = entryFrom(rows[i]);
    // Keyed by path and merged. A row links its novel once today, but the
    // "Recommended Reading" panels repeat titles across blocks and a listing
    // that gains a cover anchor tomorrow would double every row.
    if (!entry || seen[entry.url]) continue;
    seen[entry.url] = true;
    out.push(entry);
  }
  return out;
}

function listing(stem, page) {
  var n = pageNumber(page);
  var url = listingUrl(stem, n);
  var body;
  try {
    body = host.http.get(url);
  } catch (error) {
    // Past the end of the listing. The site answers 404 there rather than
    // re-serving its last page, so this is the honest end of the shelf — but
    // only after page one, where a failure is a failure.
    if (n > 1) return [];
    throw error;
  }
  return rowsIn(host.html.parse(body));
}

function documentTitle(body) {
  return host.regex.first('<title[^>]*>([\\s\\S]*?)<\\/title>', 'i', String(body || '')) || '';
}

/**
 * Whether the site actually ran the search.
 *
 * It answers a route it doesn't recognise with HTTP 200 and its **homepage**,
 * whose "Latest Release Novel" block is a table of twenty rows in exactly the
 * markup a result list uses. Read as results, every query returns the same
 * twenty unrelated novels — and the import screen would match somebody's
 * library against them. Two signals, either of which is enough: the site titles
 * the page "Search - Novelhall", and a search page is the only one with no
 * heading above its table.
 */
function isSearchResult(body, doc) {
  if (/^\s*search\b/i.test(documentTitle(body))) return true;
  return !doc.selectFirst(SELECTORS.listingHeading);
}

// MARK: - Details

function metaContent(body, property) {
  return host.regex.first(
    '<meta[^>]+property=["\']' + property + '["\'][^>]+content=["\']([^"\']*)["\']',
    'i',
    String(body || '')
  ) || '';
}

function metaName(body, name) {
  return host.regex.first(
    '<meta[^>]+name=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']',
    'i',
    String(body || '')
  ) || '';
}

/**
 * A labelled value out of the metadata strip.
 *
 * The strip reads "Author：Kazuki Miya Status：Completed UpdateTime：2022-05-11
 * 17:05", with a **full-width** colon after each label and each label in its
 * own span that `HTMLSelector` has no sibling combinator to reach. Read out of
 * the markup rather than the text, because the strip also carries a hidden hit
 * counter *inside* the author's span — its "0" lands in the middle of the text
 * and comes out as part of the author's name.
 */
function labelled(body, label) {
  var found = host.regex.first(label + '\\s*[：:]\\s*([^<>：:]{0,120})', '', String(body || ''));
  return found ? String(found).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Whether a novel is finished.
 *
 * The site says "Completed" or "Active". Anything else is left unknown rather
 * than guessed at — a novel wrongly marked complete stops the app expecting new
 * chapters for it.
 */
function statusFrom(body) {
  var raw = labelled(body, 'Status').toLowerCase();
  if (raw.indexOf('complet') >= 0 || raw.indexOf('finish') >= 0) return 'Completed';
  if (raw.indexOf('active') >= 0 || raw.indexOf('ongoing') >= 0) return 'Ongoing';
  if (raw.indexOf('hiatus') >= 0 || raw.indexOf('pause') >= 0) return 'Hiatus';
  return 'Unknown';
}

function coverFrom(node) {
  if (!node) return '';
  var raw = node.attr('data-src') || node.attr('src') || '';
  return raw ? host.absoluteUrl(raw) : '';
}

/**
 * The blurb.
 *
 * The visible copy is truncated and ends in the word "more>>"; the whole thing
 * is in a second span the site keeps at `display:none` until the reader expands
 * it. The hidden one is preferred — the opposite of the usual rule about hidden
 * text, and the reason is that here it is the author's blurb rather than
 * anti-scraping furniture.
 */
function summaryFrom(doc, body) {
  var full = doc.selectFirst(SELECTORS.detailSummaryFull);
  var text = full ? full.text() : '';
  if (!text) {
    var block = doc.selectFirst(SELECTORS.detailSummary);
    text = block ? block.text() : '';
  }
  if (!text) text = metaContent(body, 'og:description') || metaName(body, 'description');
  return String(text || '')
    // The expander's own words, which sit inside the same span as the blurb.
    .replace(/\s*(more\s*>>|back\s*<<)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// MARK: - Chapters

/**
 * One chapter row.
 *
 * `number` is the row's position in the site's own list, not anything read out
 * of the label — see the header note about "Chapter Three" and the four rows
 * that count backwards. A row with no link is skipped rather than paired with
 * the next row's URL: that is the off-by-one AGENTS.md records, where every
 * chapter below the gap points at the one above it and the list reads as
 * working until somebody notices a repeat.
 */
function chapterFrom(link, id, number) {
  var url = chapterPath(link.attr('href'), id);
  if (!url) return null;
  var name = (String(link.attr('title') || '').trim() || link.text()).replace(/\s+/g, ' ').trim();
  if (!name) name = 'Chapter ' + number;
  return { url: url, name: name, chapterNumber: number };
}

function chaptersIn(doc, id) {
  // Scoped to `#morelist`. "The Newest Chapter" above it and "Recommended
  // Reading" below use the same `<ul><li><a>` markup, and the second one links
  // other people's novels.
  var list = doc.selectFirst(SELECTORS.chapterList);
  if (!list) return [];
  var rows = list.select(SELECTORS.chapterRow);
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var row = chapterFrom(rows[i], id, out.length + 1);
    if (!row || seen[row.url]) continue;
    seen[row.url] = true;
    out.push(row);
  }
  return out;
}

/**
 * Every chapter link on the page, for a layout served without `#morelist`.
 *
 * Sorted by the numeric id in each URL, because this route also picks up "The
 * Newest Chapter", which is newest-first — left in document order the list
 * would open with chapter 677. The ids rise strictly with chapter order on
 * every novel measured, which is what makes the sort safe.
 */
function chaptersAnywhere(doc, id) {
  var rows = doc.select(SELECTORS.chapterFallback);
  var found = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var url = chapterPath(rows[i].attr('href'), id);
    if (!url || seen[url]) continue;
    seen[url] = true;
    found.push({
      url: url,
      name: (String(rows[i].attr('title') || '').trim() || rows[i].text()).replace(/\s+/g, ' ').trim(),
      sequence: chapterSequence(url)
    });
  }
  found.sort(function (a, b) { return a.sequence - b.sequence; });

  var out = [];
  for (var k = 0; k < found.length; k++) {
    out.push({
      url: found[k].url,
      name: found[k].name || ('Chapter ' + (k + 1)),
      chapterNumber: k + 1
    });
  }
  return out;
}

// MARK: - Prose

/**
 * Whether a piece is the site's noise rather than the author's words.
 *
 * Two shapes, both seen inside the container. A bare capital "P" appears
 * between paragraphs of the machine translation — twelve times in one chapter —
 * and a piece with no letters in it at all is a spacer. One-word dialogue in
 * quotes has punctuation and letters, so it survives both.
 */
function isFurniture(text) {
  var raw = String(text || '');
  if (!raw) return true;
  if (/^[A-Za-z0-9]$/.test(raw)) return true;
  if (/^(advertisement|sponsored|ads?)$/i.test(raw)) return true;
  return !/[A-Za-zÀ-ɏͰ-ӿ぀-ヿ一-鿿]/.test(raw);
}

/** Comparable form of a heading, so `'The Wishes` and `“The Wishes` match. */
function normalized(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Whether the first piece of prose is just the chapter's own title again.
 *
 * Some novels here repeat it and some don't, and the copy is not exact — the
 * heading and the prose disagree about which quote marks to use. Bounded to a
 * short opening piece so a real first paragraph cannot be eaten by a novel
 * whose title happens to be a prefix of it.
 */
function repeatsHeading(text, heading) {
  if (!heading || text.length > 120) return false;
  var a = normalized(text);
  var b = normalized(heading);
  if (!a || !b) return false;
  return a === b || b.indexOf(a) === 0 || a.indexOf(b) === 0;
}

/**
 * The chapter, one entry per paragraph.
 *
 * The container holds the whole chapter as a single run of text with `<br><br>`
 * between paragraphs and nothing wrapping them, so this reads the markup and
 * splits on the breaks. Headings, scripts, styles and anything the site might
 * inject in a block are removed first — reading the text instead would hand the
 * reader "Chapter 1: Prologue" as the novel's first line and an advert's copy
 * as its second.
 */
function paragraphsIn(container, heading) {
  var markup = typeof container.html === 'function' ? container.html() : '';
  if (!markup) return [];
  var pieces = markup
    .replace(/<(h[1-6]|script|style|iframe|ins|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(iframe|img|input)[^>]*>/gi, ' ')
    .split(/<br\s*\/?>/i);

  var out = [];
  for (var i = 0; i < pieces.length; i++) {
    var text = host.stripTags(pieces[i]).replace(/\s+/g, ' ').trim();
    if (!text || isFurniture(text)) continue;
    if (!out.length && repeatsHeading(text, heading)) continue;
    out.push({ text: text });
  }
  return out;
}

// MARK: - Source

var SourceBundle = {
  fetchPopular: function (page) {
    return listing(option('popularPath', 'ranking'), page);
  },

  fetchLatest: function (page) {
    return listing(option('latestPath', 'lastupdate'), page);
  },

  /**
   * Search.
   *
   * One page only: the results page carries an empty pager and every query
   * measured came back well inside one page of twenty. Asking for page two
   * would re-run the same query and hand the host the same rows again, which it
   * would read as more results.
   */
  fetchSearch: function (text, page) {
    var query = String(text || '').trim();
    if (!query || pageNumber(page) > 1) return [];

    var url = host.baseUrl + option('searchPath', '/index.php')
      + '?' + option('searchParams', 's=so&module=book')
      + '&' + option('searchField', 'keyword') + '=' + encodeURIComponent(query);
    var body = host.http.get(url);
    var doc = host.html.parse(body);

    // See `isSearchResult`. An empty list here must mean "this novel is not on
    // this site" and nothing else, because that answer is what the import
    // screen files a book under.
    if (!isSearchResult(body, doc)) {
      throw new Error('This site did not run the search. It may be having trouble; try again in a moment.');
    }
    return rowsIn(doc);
  },

  getMangaDetails: function (url) {
    var path = novelPath(url);
    if (!path) throw new Error('That is not a novel address on this site.');

    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    // `og:title` first because it is the clean name; the heading is the
    // fallback for a page rendered without the metadata.
    var title = metaContent(body, 'og:title').trim() || (heading ? heading.text().trim() : '');
    if (!title) {
      throw new Error('This site did not send the novel\'s page; it may have been removed.');
    }

    var details = {
      url: path,
      title: title.replace(/\s+/g, ' '),
      status: statusFrom(body),
      genres: []
    };

    details.thumbnailUrl = coverFrom(doc.selectFirst(SELECTORS.detailCover))
      || coverFrom(doc.selectFirst(SELECTORS.detailCoverAlt))
      || metaContent(body, 'og:image');

    var author = labelled(body, 'Author');
    if (author) details.author = author;

    var summary = summaryFrom(doc, body);
    if (summary) details.description = summary;

    // The genre is the one real link in the metadata strip; the others in there
    // are the hit counter's `javascript:` placeholders.
    var tags = doc.select(SELECTORS.detailGenre);
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i].text().trim();
      var href = String(tags[i].attr('href') || '');
      if (!tag || href.indexOf('/genre/') < 0) continue;
      if (details.genres.indexOf(tag) < 0) details.genres.push(tag);
    }
    return details;
  },

  /**
   * Every chapter, in one request.
   *
   * The series page carries the whole list — 870 rows for the longest novel
   * here — so there is nothing to walk and no endpoint to depend on. What there
   * is instead is three lists in the same markup and two slugs for one book;
   * see the header note.
   */
  getChapterList: function (url) {
    var path = novelPath(url);
    if (!path) throw new Error('That is not a novel address on this site.');
    var id = bookId(path);

    var doc = host.html.parse(host.http.get(host.baseUrl + path));

    var chapters = chaptersIn(doc, id);
    if (!chapters.length) chapters = chaptersAnywhere(doc, id);
    if (!chapters.length) {
      throw new Error('This site changed how it lists chapters; this source needs updating.');
    }
    return chapters;
  },

  /**
   * A chapter's prose, one entry per paragraph.
   *
   * Text blocks rather than image addresses: the host reads `{ text: … }` as a
   * page of words, and one paragraph per page is what keeps a saved reading
   * position meaningful at any text size.
   */
  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.indexOf('http') !== 0 && path.charAt(0) !== '/') path = '/' + path;
    var body = host.http.get(path.indexOf('http') === 0 ? path : host.baseUrl + path);
    var doc = host.html.parse(body);

    var container = doc.selectFirst(SELECTORS.prose);
    if (!container) {
      throw new Error('This site did not send the chapter\'s text. It may have been removed, or the site has changed.');
    }

    var headingNode = doc.selectFirst(SELECTORS.chapterHeading);
    var out = paragraphsIn(container, headingNode ? headingNode.text() : '');
    // Never an empty array: the host cannot tell that from a chapter nobody is
    // allowed to read, and the reader would show a blank page saying nothing
    // about why.
    if (!out.length) {
      throw new Error('This site sent the chapter with no text in it.');
    }
    return out;
  }
};
