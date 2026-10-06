/*
 * FreeWebNovel — JavaScript source, prose, English.
 *
 * The first English-language novel source in the community pack that carries
 * mainstream Japanese light novels. Ascendance of a Bookworm is 216 chapters
 * here and Re:Zero Kara Hajimeru Isekai Seikatsu is 657, both findable by their
 * English titles, which is the thing Syosetu cannot do and Royal Road has never
 * had.
 *
 * Six things about the site shape this file, all measured live on 2026-09-17:
 *
 *  - **The whole chapter list comes back in one request.** The reader's own
 *    dropdown is filled by `POST /api/chapterlist.php` with `aid`, `acode` and
 *    `cid`, answering `{ html: "<option value='…'>…</option>…" }` — 216 options
 *    for Bookworm in a single 23 KB response. That matters more than it looks:
 *    the series page paginates its visible list at 40, so the scraped route is
 *    seventeen requests for Re:Zero, and `SourceBudget.operation` gives a whole
 *    chapter list eight seconds. The API route is one request; the scrape is
 *    kept only as a fallback for when it stops answering.
 *
 *  - **A series page carries two `ul.ul-list5` blocks and they are not the
 *    same list.** `div.m-newest1` is "6 Latest Chapters" and `div.m-newest2 >
 *    ul#idData` is the real catalogue. An unscoped read returns the six newest
 *    twice over, once at the top of the list where chapter one belongs — the
 *    sidebar trap AGENTS.md records, and it returns a perfectly healthy list.
 *
 *  - **A listing row links its novel twice**, around the cover and around the
 *    heading, and a third time at the *chapter* it most recently posted. Taking
 *    one result per anchor triples every row and files two thirds of them under
 *    a chapter URL that opens to nothing. Rows are read one at a time out of
 *    `div.li` and keyed by their own path.
 *
 *  - **Search is a POST and it is rate limited by the site**, to one query
 *    every three seconds — a second one inside that window answers HTTP 200
 *    with "Please wait 3 seconds before searching again" and an empty result
 *    list. That is the same shape as the Cloudflare-200 trap: checking the
 *    status alone turns a throttle into "this title is not on this site". It is
 *    detected and reported as the temporary failure it is, and `rateLimitMs` is
 *    set to 3000 in the manifest so the app does not walk into it.
 *
 *  - **Covers are ordinary `<img src>`**, not lazy-loaded, but they sit inside a
 *    `<picture>` next to a `<source srcset>` of WebP variants. Reading the
 *    `srcset` would hand the reader a descriptor string ("… 100w, … 200w")
 *    rather than a URL, so the `img` is what is read.
 *
 *  - **Prose is `div#article` holding clean `<p>` elements**, with the chapter
 *    heading in an `<h4>` and every advert in a sibling div *outside* the
 *    container. Read as direct children (`#article > p`) so an advert injected
 *    into the middle of a chapter cannot arrive as a paragraph; the descendant
 *    read is the fallback for a novel whose markup nests.
 *
 * ── What a manifest may set (`host.options`, all values are strings) ─────────
 *
 *   seriesPath      path prefix for a novel, default "/novel/"
 *   popularPath     the ranking listing, default "/sort/most-popular"
 *   latestPath      the recently-updated listing, default "/sort/latest-release"
 *   searchPath      where a query is posted, default "/search"
 *   searchField     the form field a query goes in, default "keyword"
 *   pageMode        how a listing page 2 is addressed: "path" (default,
 *                   "/sort/most-popular/2") or "query" ("?page=2")
 *   chapterPageMode the same for the series page's own chapter pagination:
 *                   "query" (default, "?page=2") or "path"
 *
 * No selectors here, deliberately: `HTMLSelector` degrades silently, so a
 * mistyped one in a manifest gives wrong rows rather than an error. Selector
 * variance is handled in code by trying one and falling back when it finds
 * nothing.
 *
 * ── The other site on this platform ─────────────────────────────────────────
 *
 * `libread.com` runs the same code on the same catalogue — its chapter pages
 * are byte-identical to this site's and even link back to `/novel/…` paths —
 * so it is a mirror rather than a second source and shipping both would put
 * every result on screen twice. It also 500s on `/api/chapterlist.php`, which
 * is the one request this file depends on. If it is ever wanted, it needs
 * `seriesPath: "/libread/"`, `searchField: "searchkey"` and
 * `chapterPageMode: "path"`, and it will pay seventeen requests for a long
 * novel's chapter list.
 */

// The site's reader fills its own chapter dropdown from here. One request for
// a whole chapter list, whatever its length.
var CHAPTER_LIST_API = '/api/chapterlist.php';

// The visible chapter list on a series page holds forty rows. Only used by the
// fallback; at Re:Zero's length that route is seventeen requests.
var SCRAPED_PAGE_SIZE = 40;

// Enough for the longest novel on the site at forty rows a page, and a stop
// for a pager that starts pointing back at itself.
var MAX_CHAPTER_PAGES = 60;

var SELECTORS = {
  // A listing row. `div.li` is the row on every listing shape the site has —
  // the home recommendations, /sort/*, and a search result page.
  row: 'div.li',
  rowCoverLink: 'div.pic a',
  rowCover: 'div.pic img',
  rowTitleLink: 'h3.tit a',
  // The highest page in a listing's own pager, so paging stops at the end
  // rather than re-serving the last page forever.
  listPager: 'div.pages a',

  detailTitle: 'div.m-desc h1.tit',
  detailTitleFallback: 'div.m-info h3.tit',
  detailCover: 'div.m-imgtxt div.pic img',
  detailSummary: 'div.m-desc div.inner',
  detailSummaryFallback: 'div.txt div.inner',
  detailGenre: "div.m-imgtxt a[href*='/genre/']",
  detailAuthor: "div.m-imgtxt a[href*='/author/']",
  // The library button carries the numeric article id the chapter list API
  // wants. It is the only place on the page that states it as data.
  articleId: 'a[data-articleid]',

  // The real chapter list, scoped by id. See the header note about m-newest1.
  chapterList: 'ul#idData',
  chapterRow: 'li a',
  chapterPager: 'div#barcon a',
  chapterPagerOption: 'div#barcon option',

  prose: 'div#article',
  proseParagraphDirect: 'div#article > p',
  proseParagraph: 'p'
};

// MARK: - Manifest options

function option(key, fallback) {
  var value = (typeof host !== 'undefined' && host.options) ? host.options[key] : null;
  if (value === undefined || value === null) return fallback;
  value = String(value).trim();
  return value ? value : fallback;
}

function seriesPath() {
  var raw = option('seriesPath', '/novel/');
  if (raw.charAt(0) !== '/') raw = '/' + raw;
  if (raw.charAt(raw.length - 1) !== '/') raw = raw + '/';
  return raw;
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/** `/sort/most-popular` + page 3, in whichever of the two shapes this site uses. */
function listingUrl(path, page) {
  var n = pageNumber(page);
  if (n === 1) return host.baseUrl + path;
  if (option('pageMode', 'path') === 'query') return host.baseUrl + path + '?page=' + n;
  return host.baseUrl + path + '/' + n;
}

// MARK: - Listings

/**
 * Whether a link is this site's own novel path rather than one of its chapters.
 *
 * `/novel/shadow-slave` is a novel; `/novel/shadow-slave/chapter-3186` is not,
 * and a row links the second one as prominently as the first. Storing a chapter
 * URL as a novel gives a shelf cell that looks right and opens empty — the
 * failure AGENTS.md records for cover anchors pointing at the newest chapter.
 */
function novelPath(href) {
  var raw = String(href || '');
  if (!raw) return '';
  // Absolute links to our own host appear in `og:` metadata and occasionally in
  // markup; everything downstream wants the path.
  raw = raw.replace(/^https?:\/\/[^/]+/, '');
  var prefix = seriesPath();
  if (raw.indexOf(prefix) !== 0) return '';
  var rest = raw.slice(prefix.length).replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!rest || rest.indexOf('/') >= 0) return '';
  return prefix + rest;
}

function coverFrom(node) {
  if (!node) return '';
  // `data-src` first for the same reason every scrape in this repo does it —
  // this site serves `src` today and the cost of being wrong is every cover
  // missing while every title reads fine.
  var raw = node.attr('data-src') || node.attr('src') || '';
  return raw ? host.absoluteUrl(raw) : '';
}

/**
 * One listing row.
 *
 * The heading's anchor is preferred over the cover's: both point at the novel
 * on every shape seen, and the heading is where the label lives. `title` is
 * read before the anchor's text because the site puts the clean name there and
 * a badge or a rating can end up inside the heading — `"HOT Tales of Demons"`
 * is the shape AGENTS.md warns about.
 */
function entryFrom(row) {
  var heading = row.selectFirst(SELECTORS.rowTitleLink);
  var cover = row.selectFirst(SELECTORS.rowCoverLink);
  var path = novelPath(heading ? heading.attr('href') : '')
    || novelPath(cover ? cover.attr('href') : '');
  if (!path) return null;

  var title = '';
  if (heading) title = String(heading.attr('title') || '').trim() || heading.text().trim();
  if (!title && cover) title = String(cover.attr('title') || '').trim();
  if (!title) {
    var image = row.selectFirst(SELECTORS.rowCover);
    if (image) title = String(image.attr('alt') || '').trim();
  }
  if (!title) return null;

  return {
    url: path,
    title: title,
    thumbnailUrl: coverFrom(row.selectFirst(SELECTORS.rowCover))
  };
}

/** The highest page a listing's pager offers, so paging can stop at the end. */
function lastListPage(doc) {
  var links = doc.select(SELECTORS.listPager);
  var highest = 1;
  for (var i = 0; i < links.length; i++) {
    var href = String(links[i].attr('href') || '');
    var found = host.regex.first('(?:\\/|page=)(\\d+)\\s*$', '', href);
    var n = parseInt(found, 10);
    if (!isNaN(n) && n > highest) highest = n;
  }
  return highest;
}

function rowsIn(doc) {
  var rows = doc.select(SELECTORS.row);
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var entry = entryFrom(rows[i]);
    // Keyed by path and merged: a row links its novel from the cover and from
    // the heading, and two listings on one page (recommendations above a rank
    // list) can carry the same novel twice.
    if (!entry || seen[entry.url]) continue;
    seen[entry.url] = true;
    out.push(entry);
  }
  return out;
}

function listing(path, page) {
  var n = pageNumber(page);
  var doc = host.html.parse(host.http.get(listingUrl(path, n)));
  var rows = rowsIn(doc);

  // Past the end. The site re-serves its last page rather than answering 404,
  // so without this the host keeps asking and the shelf grows duplicates.
  if (n > 1 && n > lastListPage(doc)) return [];
  return rows;
}

// MARK: - Search

/**
 * The site's own throttle, which arrives with HTTP 200.
 *
 * Same trap as a Cloudflare challenge served with a 200, and with the same
 * consequence if it is missed: an empty result list reads as "this novel is not
 * here", so a title the user owns gets filed as unmatched. Matched on the
 * site's own sentence rather than on the empty list, because an honestly empty
 * search looks identical.
 */
function isThrottled(body) {
  return /wait\s+\d+\s+seconds?\s+before\s+searching/i.test(String(body || ''));
}

// MARK: - Details

function metaContent(body, property) {
  return host.regex.first(
    '<meta[^>]+property=["\']' + property + '["\'][^>]+content=["\']([^"\']*)["\']',
    'i',
    String(body || '')
  ) || '';
}

/**
 * Whether a novel is finished.
 *
 * The site states this in its own metadata as "Completed" or "OnGoing"; the
 * visible row is a link whose text is the same word. Anything else is left
 * unknown rather than guessed at — a novel wrongly marked complete stops the
 * app expecting new chapters for it.
 */
function statusFrom(body) {
  var raw = metaContent(body, 'og:novel:status').toLowerCase();
  if (raw.indexOf('complet') >= 0) return 'Completed';
  if (raw.indexOf('ongoing') >= 0 || raw.indexOf('on going') >= 0) return 'Ongoing';
  if (raw.indexOf('hiatus') >= 0 || raw.indexOf('pause') >= 0) return 'Hiatus';
  return 'Unknown';
}

// MARK: - Chapters

/**
 * The numeric article id, which `/api/chapterlist.php` will not answer without.
 *
 * Stated as `data-articleid` on the Add-to-Library button, and again inside the
 * comments configuration script. The button is read first because it is markup
 * rather than a JavaScript literal; the script is the fallback for a page that
 * renders without the button (a logged-in view does).
 */
function articleId(doc, body) {
  var node = doc.selectFirst(SELECTORS.articleId);
  var fromMarkup = node ? String(node.attr('data-articleid') || '').trim() : '';
  if (/^\d+$/.test(fromMarkup)) return fromMarkup;

  var fromScript = host.regex.first('articleId["\']?\\s*[:=]\\s*["\']?(\\d+)', '', String(body || ''));
  return /^\d+$/.test(String(fromScript)) ? String(fromScript) : '';
}

function slugOf(path) {
  var prefix = seriesPath();
  var raw = String(path || '').replace(/^https?:\/\/[^/]+/, '');
  if (raw.indexOf(prefix) !== 0) return '';
  return raw.slice(prefix.length).replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * A chapter's number, out of its URL.
 *
 * The URL's own index is the site's ordering. The label is not: it reads
 * "CH.1 - Prologue" on one novel, "Volume 7 CH.11: …" on the next and
 * "Drama CD 3 SS: …" on the one after, and a volume number in front would sort
 * the list into nonsense. One site in this family zero-pads ("chapter-0216"),
 * which parses the same.
 */
function chapterNumber(url) {
  var found = host.regex.first('chapter-0*(\\d+)', '', String(url || ''));
  var n = parseInt(found, 10);
  return isNaN(n) ? null : n;
}

/**
 * One chapter row, from a `<option>` or an `<li><a>`.
 *
 * A row with no href is skipped rather than paired with the next row's URL.
 * That is the off-by-one AGENTS.md records: everything below the gap points at
 * the chapter above it, and the list reads as working until someone notices a
 * repeat.
 */
function chapterFrom(href, label, slug) {
  var url = String(href || '').replace(/^https?:\/\/[^/]+/, '');
  if (!url) return null;
  // Scoped to this novel's own path. The recommendation blocks further down a
  // series page link other novels' chapters with the same row markup.
  if (url.indexOf(seriesPath() + slug + '/') !== 0) return null;

  var name = String(label || '').trim().replace(/\s+/g, ' ');
  var number = chapterNumber(url);
  if (!name) name = number == null ? url : ('Chapter ' + number);

  var chapter = { url: url, name: name };
  if (number != null) chapter.chapterNumber = number;
  return chapter;
}

function dedupe(chapters) {
  var out = [];
  var seen = {};
  for (var i = 0; i < chapters.length; i++) {
    var row = chapters[i];
    if (!row || seen[row.url]) continue;
    seen[row.url] = true;
    out.push(row);
  }
  return out;
}

/**
 * Every chapter, in one request, from the endpoint the site's own reader uses.
 *
 * Answers `{ html: "<option …>" }`. An `error` key instead is the site refusing
 * the query, and is thrown rather than returned empty: an empty chapter list
 * reads as a novel nobody has posted to yet.
 */
function chaptersFromApi(slug, id) {
  var body = host.http.postForm(host.baseUrl + CHAPTER_LIST_API, {
    aid: id, acode: slug, cid: '1'
  });
  var payload = JSON.parse(body);
  if (!payload || !payload.html) return [];

  var options = host.html.parse(payload.html).select('option');
  var out = [];
  for (var i = 0; i < options.length; i++) {
    var row = chapterFrom(options[i].attr('value'), options[i].text(), slug);
    if (row) out.push(row);
  }
  return dedupe(out);
}

/** How many pages the series page's own chapter pager offers. */
function lastChapterPage(doc) {
  // The pager is a `<select>` of ranges ("C.1 - C.40", "C.41 - C.80", …), one
  // option per page. On this site every option's value is the same URL — the
  // page number is added by the site's own script — so the count of options is
  // what says how many pages there are, and the hrefs are read only as a
  // second opinion for a sibling site that numbers them.
  var options = doc.select(SELECTORS.chapterPagerOption);
  var highest = options.length > 1 ? options.length : 1;

  var links = doc.select(SELECTORS.chapterPager);
  for (var i = 0; i < links.length; i++) {
    var found = host.regex.first('(?:\\/|page=)(\\d+)\\s*$', '', String(links[i].attr('href') || ''));
    var n = parseInt(found, 10);
    if (!isNaN(n) && n > highest) highest = n;
  }
  return Math.min(highest, MAX_CHAPTER_PAGES);
}

function chaptersOn(doc, slug) {
  // Scoped to `ul#idData`. The "6 Latest Chapters" block above it is the same
  // `ul.ul-list5` markup, so an unscoped read puts the newest six at the top
  // of the list where chapter one belongs and duplicates them.
  var list = doc.selectFirst(SELECTORS.chapterList);
  var rows = list ? list.select(SELECTORS.chapterRow) : [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = chapterFrom(
      rows[i].attr('href'),
      String(rows[i].attr('title') || '').trim() || rows[i].text(),
      slug
    );
    if (row) out.push(row);
  }
  return out;
}

function chapterPageUrl(path, page) {
  if (page === 1) return host.baseUrl + path;
  if (option('chapterPageMode', 'query') === 'path') return host.baseUrl + path + '/' + page;
  return host.baseUrl + path + '?page=' + page;
}

/**
 * Every chapter by walking the series page's visible list.
 *
 * Forty rows a page, so this is six requests for Bookworm and seventeen for
 * Re:Zero — which is why it is the fallback and not the route. Kept because the
 * API is one endpoint and one endpoint can go away, and a novel source that
 * cannot list chapters is a novel source that cannot be read.
 */
function chaptersByPaging(doc, path, slug) {
  var out = chaptersOn(doc, slug);
  if (!out.length) return [];

  var pages = lastChapterPage(doc);
  var seen = {};
  for (var s = 0; s < out.length; s++) seen[out[s].url] = true;

  for (var p = 2; p <= pages; p++) {
    var more = chaptersOn(host.html.parse(host.http.get(chapterPageUrl(path, p))), slug);
    if (!more.length) break;
    var added = 0;
    for (var i = 0; i < more.length; i++) {
      if (seen[more[i].url]) continue;
      seen[more[i].url] = true;
      out.push(more[i]);
      added++;
    }
    // A pager that points back at a page already read would otherwise walk to
    // MAX_CHAPTER_PAGES, one request each.
    if (!added) break;
    if (more.length < SCRAPED_PAGE_SIZE) break;
  }
  return out;
}

// MARK: - Prose

/**
 * Class names an inline stylesheet hides.
 *
 * Royal Road salts its chapters with a decoy line behind a random hidden class,
 * and this site does not do that today. Checking costs one regex, and the
 * failure it prevents is anti-scraping furniture read out to the reader as
 * prose, with nothing throwing.
 */
function hiddenClassNames(body) {
  var rules = host.regex.all('\\.([A-Za-z][\\w-]*)\\s*\\{[^}]*display:\\s*none', '', String(body || ''));
  var names = {};
  for (var i = 0; i < rules.length; i++) names[rules[i][1]] = true;
  return names;
}

function isHidden(node, hiddenNames) {
  var classes = String(node.attr('class') || '').split(/\s+/);
  for (var i = 0; i < classes.length; i++) {
    if (classes[i] && hiddenNames[classes[i]]) return true;
  }
  return String(node.attr('style') || '').replace(/\s+/g, '').indexOf('display:none') >= 0;
}

/**
 * Whether a paragraph is the site's furniture rather than the author's words.
 *
 * Every advert on a chapter page sits outside `div#article`, so this is a
 * second line rather than the first. It catches the two that have been seen
 * inside a container: the translator credit line the site prepends, which is
 * wanted, and a bare advert label, which is not.
 */
function isFurniture(text) {
  var raw = String(text || '');
  if (!raw) return true;
  if (/^(advertisement|sponsored|ads?)$/i.test(raw)) return true;
  // No letters or ideographs at all: a spacer, a row of bullets, an empty
  // paragraph holding a `<br>`.
  return !/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿]/.test(raw);
}

function paragraphNodes(container, doc) {
  // Direct children first: an advert injected into the middle of a chapter
  // arrives inside its own div, and reading descendants would hand its copy to
  // the reader as a paragraph of the novel.
  var direct = doc.select(SELECTORS.proseParagraphDirect);
  if (direct.length) return direct;
  return container.select(SELECTORS.proseParagraph);
}

/**
 * Paragraphs out of a container that separates them with `<br>` rather than
 * wrapping each one.
 *
 * Some novels on this platform are stored that way, and the `<p>` read finds
 * nothing on them — a chapter that exists, loads, and arrives empty.
 */
function paragraphsFromBreaks(container) {
  var markup = typeof container.html === 'function' ? container.html() : '';
  if (!markup) return [];
  // The chapter heading lives inside the container as an `<h4>`, and scripts
  // and styles can too. Splitting the raw markup would hand the reader
  // "Chapter 1: Prologue" as the novel's first paragraph.
  var parts = markup
    .replace(/<(h[1-6]|script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .split(/<br\s*\/?>/i);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var text = host.stripTags(parts[i]).replace(/\s+/g, ' ').trim();
    if (!text || isFurniture(text)) continue;
    out.push({ text: text });
  }
  return out;
}

function paragraphsIn(container, doc, body) {
  var hidden = hiddenClassNames(body);
  var nodes = paragraphNodes(container, doc);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    if (isHidden(nodes[i], hidden)) continue;
    var text = nodes[i].text().replace(/\s+/g, ' ').trim();
    if (!text || isFurniture(text)) continue;
    out.push({ text: text });
  }
  if (out.length) return out;
  return paragraphsFromBreaks(container);
}

// MARK: - Source

var SourceBundle = {
  fetchPopular: function (page) {
    return listing(option('popularPath', '/sort/most-popular'), page);
  },

  fetchLatest: function (page) {
    return listing(option('latestPath', '/sort/latest-release'), page);
  },

  /**
   * Search, which is a form POST rather than a URL.
   *
   * Only page one exists: the site's results page carries no pager, and every
   * query measured came back inside one page of twenty. Asking for page two
   * would re-post the same query and return the same rows, which the host would
   * read as more results.
   */
  fetchSearch: function (text, page) {
    var query = String(text || '').trim();
    if (!query || pageNumber(page) > 1) return [];

    var fields = {};
    fields[option('searchField', 'keyword')] = query;
    var body = host.http.postForm(host.baseUrl + option('searchPath', '/search'), fields);

    if (isThrottled(body)) {
      throw new Error('This site allows one search every few seconds. Try again in a moment.');
    }
    return rowsIn(host.html.parse(body));
  },

  getMangaDetails: function (url) {
    var path = novelPath(url);
    if (!path) throw new Error('That is not a novel address on this site.');

    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);

    var heading = doc.selectFirst(SELECTORS.detailTitle) || doc.selectFirst(SELECTORS.detailTitleFallback);
    // `og:title` is the clean name; the heading can carry a badge. Preferred
    // for that reason, with the heading as the fallback.
    var title = metaContent(body, 'og:title').trim() || (heading ? heading.text().trim() : '');
    if (!title) {
      throw new Error('This site did not send the novel\'s page; it may have been removed.');
    }

    var details = {
      url: path,
      title: title,
      status: statusFrom(body),
      genres: []
    };

    var cover = coverFrom(doc.selectFirst(SELECTORS.detailCover));
    details.thumbnailUrl = cover || metaContent(body, 'og:image');

    var author = metaContent(body, 'og:novel:author').trim();
    if (!author) {
      var authorLink = doc.selectFirst(SELECTORS.detailAuthor);
      if (authorLink) author = authorLink.text().trim();
    }
    // The site lists a Japanese novel's author twice, romanised and in
    // Japanese. The first is the one an English-reading shelf wants.
    if (author) details.author = author.split(',')[0].trim();

    var summary = doc.selectFirst(SELECTORS.detailSummary) || doc.selectFirst(SELECTORS.detailSummaryFallback);
    var description = summary ? summary.text().trim() : metaContent(body, 'og:description').trim();
    if (description) details.description = description;

    var genres = String(metaContent(body, 'og:novel:genre') || '').split(',');
    for (var i = 0; i < genres.length; i++) {
      var genre = genres[i].trim();
      if (genre && details.genres.indexOf(genre) < 0) details.genres.push(genre);
    }
    if (!details.genres.length) {
      var tags = doc.select(SELECTORS.detailGenre);
      for (var t = 0; t < tags.length; t++) {
        var tag = tags[t].text().trim();
        if (tag && details.genres.indexOf(tag) < 0) details.genres.push(tag);
      }
    }
    return details;
  },

  getChapterList: function (url) {
    var path = novelPath(url);
    if (!path) throw new Error('That is not a novel address on this site.');
    var slug = slugOf(path);

    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);

    // One request for the whole list, however long it is. See the header note:
    // the scraped route is seventeen requests for a 657-chapter novel and a
    // chapter list is given eight seconds.
    var id = articleId(doc, body);
    if (id) {
      var fromApi = [];
      try {
        fromApi = chaptersFromApi(slug, id);
      } catch (error) {
        // The endpoint refusing is not the novel having no chapters. Fall
        // through to the visible list rather than reporting an empty one.
        fromApi = [];
      }
      if (fromApi.length) return fromApi;
    }

    var scraped = chaptersByPaging(doc, path, slug);
    if (!scraped.length) {
      throw new Error('This site changed how it lists chapters; this source needs updating.');
    }
    return dedupe(scraped);
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

    var out = paragraphsIn(container, doc, body);
    // Never an empty array: the host cannot tell that from a chapter nobody is
    // allowed to read, and the reader would show a blank page saying nothing
    // about why.
    if (!out.length) {
      throw new Error('This site sent the chapter with no text in it.');
    }
    return out;
  }
};
