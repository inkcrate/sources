/*
 * LNORI: JavaScript source, prose, English.
 *
 * Added for the licensed Japanese light novels none of the other novel sources
 * list: Sword Art Online, Konosuba, Spice and Wolf, Mushoku Tensei, Durarara!!,
 * Baccano!, Ascendance of a Bookworm (all five parts) and several hundred more.
 * The library page lists 884 series. The text is the official English
 * translation, served as plain paragraphs.
 *
 * Every point below was measured on 2026-10-05 through the app's own client.
 *
 *  - **One page holds a whole volume, and a volume is the chapter here.** A
 *    volume page is about 500-600 KB: one `<article>` holding 50-65
 *    `<section class="chapter">` blocks with a table of contents above it.
 *    Splitting a volume on its contents would mean fetching every volume of a
 *    series to build the chapter list (33 for Bookworm, about 600 KB each,
 *    one per rate-limit slot), against the eight seconds the app gives a whole
 *    chapter list. So the list is the series page's volumes, in one request,
 *    and opening one fetches that one volume. Each chapter heading inside it
 *    arrives as a paragraph of its own, so the reader still sees where one
 *    chapter ends and the next begins. Measured: Bookworm part 1 volume 1 is
 *    2,563 paragraphs and 447,514 characters; part 4 volume 9, the largest
 *    seen, is 2,603 paragraphs and 531,701 characters.
 *
 *  - **Volume order is the series page's order; a volume's number is its own.**
 *    The numeric ids don't rise with the order (Monogatari's first three are
 *    17860, 17874, 17873), so the list keeps the page's order. The number is
 *    what a tracker hears when a volume is finished, and a tracker is never
 *    moved back, so a number too high is never put right. Numbering by place
 *    in the list was too high, in a sweep of every series page on 8 Oct 2026,
 *    for every series that files an extra book or a half volume in the run.
 *    So, in order (`numberVolumes`):
 *    - A volume takes its own number, from its label ("Volume 7") or its
 *      address ("…-vol-04-5" is 4.5; the label there says only "Volume 4").
 *    - A book outside the numbered run is a side story: one with no number in
 *      a numbered series (No Game No Life's "Practical War Game"), and one
 *      whose number goes back to restart nothing (Index's two short-story
 *      books, "Volume 1" and "Volume 2" between volumes 13 and 17). Its name
 *      reads as a side story to the app ("Side story: " goes in front when
 *      its own label doesn't), so it never moves the tracker.
 *    - A run that starts again at 1 and carries on is a new part (Bookworm's
 *      five, Classroom of the Elite's years). Its volumes count on from the
 *      part before, the way a whole-series tracker counts them.
 *    - A series with no volume numbers (Monogatari, Haruhi) goes by place.
 *
 *  - **The library is one page with every series on it, 1.8 MB.** There is no
 *    pager; the site sorts and filters it in the browser. It is fetched once
 *    and kept for half an hour, so the popular shelf's later pages and every
 *    search after the first cost nothing.
 *
 *  - **Search is the site's own: a filter over the library.** Its search box
 *    sends you to `/library#q=…`, which filters the same page in the browser,
 *    and its structured data names that address as the search. (A JSON route
 *    in the homepage's script, `/library/search`, answers 404.) Matching is by
 *    words, with "&" read as "and", so "Spice & Wolf" finds "Spice and Wolf".
 *
 *  - **Pictures are left out.** Volumes carry their colour plates and maps as
 *    `<picture>` blocks between sections, and a chapter of prose can't mix in
 *    images. Sections that are only a picture are skipped, headings and all.
 *
 *  - **Each section repeats its heading.** `h2.chapter-title` sits above the
 *    text and a second `h2` opens the text itself. The first is kept, once;
 *    the second is dropped.
 *
 *  - **Thirty-two library cards carry `data-tags` with no value**, so the
 *    attributes are read one at a time, never as one fixed pattern.
 *
 * No latest shelf: the site keeps no list of what changed recently.
 *
 * Nothing here reads `host.options`. One site, one shape.
 */

var LIBRARY_PATH = '/library';
var PAGE_SIZE = 20;
// How long the library is kept between calls. The site itself tells browsers
// to keep it for a month; half an hour keeps a session's shelves and searches
// to one fetch without holding a stale list for days.
var LIBRARY_TTL_MS = 30 * 60 * 1000;

var libraryCache = null;

// MARK: - Text

var NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü',
  ouml: 'ö', auml: 'ä', times: '×', middot: '·'
};

/**
 * Entities, in one pass.
 *
 * The site writes titles with `&#38;` and `&#34;` and the odd `&amp;` in
 * prose. One pass rather than a chain of replaces, so `&amp;lt;` stays the
 * text "&lt;" instead of turning into "<".
 */
function decode(text) {
  var raw = String(text || '');
  if (raw.indexOf('&') < 0) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (whole, name) {
    if (name.charAt(0) === '#') {
      var code = name.charAt(1) === 'x' || name.charAt(1) === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      if (isNaN(code) || code < 1 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch (e) { return whole; }
    }
    var found = NAMED_ENTITIES[name] || NAMED_ENTITIES[name.toLowerCase()];
    return found !== undefined ? found : whole;
  });
}

/** Markup to one clean line of text. */
function plain(markup) {
  return decode(String(markup || '')
    // A reading printed above a word would otherwise run into the word.
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/[\s ]+/g, ' ')
    .trim();
}

function attribute(tag, name) {
  var match = new RegExp('\\s' + name + '="([^"]*)"').exec(String(tag || ''));
  return match ? decode(match[1]) : '';
}

// MARK: - Addresses

function pathOf(href) {
  return String(href || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '');
}

/**
 * A series address, `/series/4239/ascendance-of-a-bookworm-…`, or '' if the
 * link is not one. Volumes (`/book/…`) and genres (`/genre/…`) sit beside
 * series links in the same cards.
 */
function seriesPath(href) {
  var raw = pathOf(href);
  var match = /^\/series\/(\d+)(\/[^/]+)?\/?$/.exec(raw);
  return match ? '/series/' + match[1] + (match[2] || '') : '';
}

/** A volume address, `/book/14185/…`, or ''. */
function bookPath(href) {
  var raw = pathOf(href);
  var match = /^\/book\/(\d+)(\/[^/]+)?\/?$/.exec(raw);
  return match ? '/book/' + match[1] + (match[2] || '') : '';
}

function slugOf(path) {
  var match = /^\/(?:series|book)\/\d+\/([^/]+)/.exec(String(path || ''));
  return match ? match[1] : '';
}

function absolute(href) {
  var raw = String(href || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.indexOf('//') === 0) return 'https:' + raw;
  return host.baseUrl.replace(/\/+$/, '') + (raw.charAt(0) === '/' ? '' : '/') + raw;
}

// MARK: - The library

/**
 * Every card on the library page, in the site's own order (most read first).
 *
 * Read with plain string work rather than the element tree: the page is
 * 1.8 MB and 884 cards, and only each card's opening tag, its first series
 * link and its first image are needed.
 */
function cardsIn(body) {
  var text = String(body || '');
  var opener = /<article\b[^>]*\bclass="card\b[^"]*"[^>]*>/g;
  var starts = [];
  var match;
  while ((match = opener.exec(text)) !== null) {
    starts.push({ index: match.index, tag: match[0] });
  }

  var out = [];
  var seen = {};
  for (var i = 0; i < starts.length; i++) {
    var end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    var chunk = text.slice(starts[i].index, end);
    var close = chunk.indexOf('</article>');
    if (close >= 0) chunk = chunk.slice(0, close);

    var link = /href="([^"]*\/series\/\d+[^"]*)"/.exec(chunk);
    var url = link ? seriesPath(link[1]) : '';
    if (!url || seen[url]) continue;

    var title = attribute(starts[i].tag, 'data-t');
    if (!title) {
      var heading = /<h[23][^>]*class="card-title"[^>]*>([\s\S]*?)<\/h[23]>/.exec(chunk);
      title = heading ? plain(heading[1]) : '';
    }
    title = title.replace(/\s+/g, ' ').trim();
    if (!title) continue;
    seen[url] = true;

    // Lazy-loaded art leaves `src` empty on many sites; this one fills it,
    // but `data-src` is read first in case that changes.
    var image = /<img\b[^>]*\sdata-src="([^"]+)"/.exec(chunk) || /<img\b[^>]*\ssrc="([^"]+)"/.exec(chunk);
    var entry = { url: url, title: title };
    if (image) entry.thumbnailUrl = absolute(decode(image[1]));

    var author = attribute(starts[i].tag, 'data-a');
    if (author) entry.author = author;

    out.push(entry);
  }
  return out;
}

function library() {
  var now = Date.now();
  if (libraryCache && now - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.rows;

  var rows = cardsIn(host.http.get(host.baseUrl + LIBRARY_PATH));
  if (!rows.length) {
    throw new Error('This site changed how it lists its library; this source needs updating.');
  }
  libraryCache = { at: now, rows: rows };
  return rows;
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

function pageOf(rows, page) {
  var start = (pageNumber(page) - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE).map(function (row) {
    var copy = { url: row.url, title: row.title };
    if (row.thumbnailUrl) copy.thumbnailUrl = row.thumbnailUrl;
    if (row.author) copy.author = row.author;
    return copy;
  });
}

// MARK: - Search

/** Lowercase words, with "&" as "and" and apostrophes dropped. */
function words(text) {
  return decode(String(text || ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’`]/g, '')
    .replace(/[^0-9a-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿]+/g, ' ')
    .trim()
    .split(' ')
    .filter(function (w) { return w.length > 0; });
}

/**
 * How well a title answers a query: 3 the same words, 2 every word of the
 * query is in the title, 1 the title is the start of the query
 * ("Rascal Does Not Dream" for "Rascal Does Not Dream of Bunny Girl Senpai"),
 * 0 not at all.
 *
 * The third rule needs a title of eight letters or more, so a short name
 * doesn't answer every query that happens to begin with it.
 */
function score(titleWords, queryWords) {
  if (!queryWords.length || !titleWords.length) return 0;
  var title = titleWords.join(' ');
  var query = queryWords.join(' ');
  if (title === query) return 3;

  var have = {};
  for (var i = 0; i < titleWords.length; i++) have[titleWords[i]] = true;
  var all = true;
  for (var k = 0; k < queryWords.length; k++) {
    if (!have[queryWords[k]]) { all = false; break; }
  }
  if (all) return 2;

  if (title.replace(/ /g, '').length >= 8 && (query + ' ').indexOf(title + ' ') === 0) return 1;
  return 0;
}

function matching(rows, query) {
  var queryWords = words(query);
  var found = [];
  for (var i = 0; i < rows.length; i++) {
    var s = score(words(rows[i].title), queryWords);
    if (s > 0) found.push({ row: rows[i], score: s, order: i });
  }
  // Best match first, and the site's own order (most read first) after that.
  found.sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
  return found.map(function (f) { return f.row; });
}

// MARK: - Details

function metaContent(body, property) {
  var match = new RegExp(
    '<meta[^>]+(?:property|name)="' + property + '"[^>]+content="([^"]*)"', 'i'
  ).exec(String(body || ''));
  return match ? decode(match[1]) : '';
}

function coverFrom(node) {
  if (!node) return '';
  var raw = node.attr('data-src') || node.attr('src') || '';
  return raw ? absolute(raw) : '';
}

function seriesTitle(doc, body) {
  var heading = doc.selectFirst('h1.s-title') || doc.selectFirst('.hero-card h1');
  var title = heading ? heading.text() : '';
  if (!title) title = metaContent(body, 'og:title').replace(/\s*\|\s*Lnori\s*$/i, '');
  return String(title || '').replace(/\s+/g, ' ').trim();
}

// MARK: - Volumes

function comparable(text) {
  return String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * A volume's label, without the series name the site puts in front of it.
 *
 * "Ascendance of a Bookworm: I'll Do Anything to Become a Librarian! Part 1:
 * Daughter of a Soldier Volume 1" reads "Part 1: Daughter of a Soldier
 * Volume 1"; "Sword Art Online 1: Aincrad" reads "Volume 1: Aincrad".
 */
function volumeLabel(name, series) {
  var rest = labelRest(name, series);
  // A volume named only by the series name says nothing; the caller names it
  // from its address instead.
  if (!rest) return '';
  if (/^\d/.test(rest)) rest = 'Volume ' + rest;
  return rest;
}

/**
 * A label with the series name taken off the front, as written.
 *
 * Only when the name ends there: "Rascal Does Not Dream of Bunny Girl Senpai"
 * under "Rascal Does Not Dream" is a title that runs on, and keeps every word.
 * Grimgar's "level.1 Whisper, Chant, Prayer, Awaken" is a volume, and loses it.
 */
function labelRest(name, series) {
  var full = String(name || '').replace(/\s+/g, ' ').trim();
  var prefix = comparable(series);
  if (!prefix || comparable(full).indexOf(prefix) !== 0) return full;
  var after = full.slice(prefix.length);
  // "… of Bunny Girl Senpai" runs on; "… vol 1" doesn't.
  if (/^\s+(?!vol\b|volume\b)[a-z]+\s/.test(after)) return full;
  return after.replace(/^[\s:,\-–—]+/, '').trim();
}

/**
 * A label read off the address: "a-certain-magical-index-ss-vol-1" under
 * "a-certain-magical-index" is "SS Volume 1", and "…-year-2-vol-04-5" is
 * "Year 2 Volume 4.5". An address that doesn't open with the series' is read
 * whole: Crest of the Stars lists its sequel as "banner-of-the-stars-volume-1".
 */
function labelFromSlug(path, seriesSlug) {
  var rest = startsWithSeries(path, seriesSlug) ? slugRest(path, seriesSlug) : slugOf(path);
  rest = rest.replace(/(^|-)(vol(?:ume)?-\d+)-(\d)(?=-|$)/, '$1$2.$3');
  var words = rest.split('-').filter(Boolean);
  return words.map(function (word, i) {
    if (word === 'vol' || word === 'volume') return 'Volume';
    if (/^\d/.test(word)) return word.replace(/^0+(?=\d)/, '');
    // Small words stay small, except where a title or subtitle starts.
    if (i > 0 && SMALL_WORDS.test(word) && !/^\d/.test(words[i - 1])) return word;
    if (CAPITAL_WORDS.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

var SMALL_WORDS = /^(?:a|an|and|as|at|by|for|in|of|on|or|the|to|with)$/;
/** Abbreviations the site uses ("SS", "SP", "SH", "EX") and Roman numerals. */
var CAPITAL_WORDS = /^(?:ss|sp|sh|ex|[ivx]{1,4})$/;

/** Whether a book's address opens with the whole series address. */
function startsWithSeries(path, seriesSlug) {
  var slug = slugOf(path);
  return !!seriesSlug && slug.indexOf(seriesSlug + '-') === 0;
}

/**
 * The words of a book's address after the ones it shares with the series
 * address. "a-certain-magical-index-ss-vol-1" under "a-certain-magical-index"
 * is "ss-vol-1"; Bookworm's "ascendance-of-a-bookworm-part-1-…-volume-1" under
 * "ascendance-of-a-bookworm-ill-do-anything-…" is "part-1-…-volume-1".
 */
function slugRest(path, seriesSlug) {
  var words = slugOf(path).split('-').filter(Boolean);
  var shared = String(seriesSlug || '').split('-').filter(Boolean);
  var k = 0;
  while (k < words.length && k < shared.length && words[k] === shared[k]) k++;
  return words.slice(k).join('-');
}

// MARK: - Volume numbers

/** "Volume 4.5", "Vol. 12" in a label. */
var LABEL_VOLUME = /\bvol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i;
/**
 * "vol-12", "volume-08-5" in an address. A lone digit after the number is its
 * decimal, almost always a half volume: the site's labels say "Volume 4" for
 * both 4 and 4.5, and only the address tells them apart.
 */
var SLUG_VOLUME = /(?:^|-)vol(?:ume)?-0*(\d+)(?:-(\d))?(?=-|$)/;
/**
 * Words that mark a book as outside the numbered run: short-story and
 * side-story collections and extras. Read only where the number can't settle
 * it (see `numberVolumes`), since a volume in the run can be a story
 * collection and still be counted (Spice and Wolf's "Side Colors"). "EX" only
 * at the end ("Disc EX", "#EX"), so "Ex-Hero" isn't one.
 */
var SIDE_WORDS = /\b(?:short stor(?:y|ies)|side stor(?:y|ies)|gaiden|omake|extras?|bonus|anthology)\b|\bex\s*\d*$/i;
/**
 * "SS" for short stories, only as a word of the address ("…-ss-vol-1"). In a
 * label it is as often a rank ("SSランク").
 */
var SLUG_SS = /(?:^|-)ss(?:-|$)/;
/**
 * Words that name a part of a longer series ("Part 2", "Year 3"): the only
 * thing that says a "Volume 1" at the very end of a list starts a new part
 * rather than being one more side book.
 */
var PART_WORDS = /\b(?:part|year|season|arc|book)\s*\d/i;

/**
 * A book's own volume number, or null.
 *
 * The label's "Volume N" first, made a half by the address ("Volume 4" at
 * "…-vol-04-5" is 4.5); then the address; then a label that opens with its
 * number ("Sword Art Online 1: Aincrad").
 */
function ownNumber(rest, slug) {
  var fromSlug = SLUG_VOLUME.exec(slug);
  var slugNumber = fromSlug ? parseFloat(fromSlug[1] + (fromSlug[2] ? '.' + fromSlug[2] : '')) : null;
  var label = LABEL_VOLUME.exec(rest);
  if (label) {
    var n = parseFloat(label[1]);
    return slugNumber !== null && Math.floor(slugNumber) === n ? slugNumber : n;
  }
  if (slugNumber !== null) return slugNumber;
  var leading = /^(\d+(?:\.\d+)?)(?=\D|$)/.exec(rest);
  return leading ? parseFloat(leading[1]) : null;
}

/**
 * The facts `numberVolumes` decides on, for each volume once: its label, its
 * own number, and whether its words mark it as a side book or a later part.
 * A volume listed twice (the grid links some twice) is kept once.
 */
function booksOf(volumes, series, seriesSlug) {
  var out = [];
  var seen = {};
  for (var i = 0; i < volumes.length; i++) {
    var volume = volumes[i];
    if (seen[volume.url]) continue;
    seen[volume.url] = true;
    var rest = labelRest(volume.name, series);
    var slug = slugRest(volume.url, seriesSlug);
    var words = rest + ' ' + slug.replace(/-/g, ' ');
    var slugLabel = labelFromSlug(volume.url, seriesSlug);
    // A book named only by the series takes its name from the address, but
    // only an address that opens with the series' ("…-zero-second-journet"
    // under "…-zero-second-journey" would read "Journet").
    var label = volumeLabel(volume.name, series)
      || (startsWithSeries(volume.url, seriesSlug) ? slugLabel : '')
      || volume.name || ('Volume ' + (out.length + 1));
    out.push({
      url: volume.url,
      label: label,
      slugLabel: slugLabel,
      number: ownNumber(rest, slug),
      flagged: SIDE_WORDS.test(rest) || SIDE_WORDS.test(slug.replace(/-/g, ' ')) || SLUG_SS.test(slug),
      // Already a side story to the app by its name, whatever its number.
      named: readsAsSideStory(label),
      // Named by the series alone.
      bare: !rest,
      partWords: PART_WORDS.test(words)
    });
  }
  return out;
}

/**
 * Each book's chapter number, whether it's a side story, and which part of
 * the series it's in (0 for the first), in the page's order. `books` come
 * from `booksOf`.
 *
 * See the header note for why. In short: the number is what a tracker hears,
 * so it is the book's own, never its place, and a book outside the run gets
 * none of the run's numbers. Side books are numbered 1, 2, 3 among
 * themselves, so they keep the page's order after the main run.
 */
function numberVolumes(books) {
  // A number far past what the page could hold is part of a title ("Another
  // 2001", Adachi and Shimamura's "99.9"), not a volume.
  var ceiling = Math.max(books.length * 3, books.length + 20);
  books = books.map(function (book) {
    if (book.named) return { number: null, flagged: true, partWords: false };
    if (book.number === null || book.number <= ceiling) return book;
    return { number: null, flagged: book.flagged, partWords: book.partWords };
  });
  // A first book named only by the series, with no number, is its first
  // volume when the numbers after it start at 1 or 2: the site names a
  // series' first book by the series alone ("Hello, I am a Witch…" then
  // "Volume 2"). Before a "Volume 1" the two share the number.
  var firstNumber = null;
  for (var f = 0; f < books.length && firstNumber === null; f++) {
    if (books[f].number !== null && !books[f].flagged) firstNumber = books[f].number;
  }
  if (books.length > 1 && books[0].bare && books[0].number === null && !books[0].flagged
      && (firstNumber === 1 || firstNumber === 2)) {
    books[0] = { number: 1, flagged: false, partWords: books[0].partWords };
  }
  var numbered = 0;
  for (var i = 0; i < books.length; i++) if (books[i].number !== null) numbered++;
  var out = [];
  var sides = 0;
  function side() { sides++; return { number: sides, side: true, part: 0 }; }

  // Mostly unnumbered (Monogatari's arcs, Haruhi's books): by place.
  if (numbered * 2 < books.length) {
    var place = 0;
    for (var p = 0; p < books.length; p++) {
      out.push(books[p].flagged ? side() : { number: ++place, side: false, part: 0 });
    }
    return out;
  }

  // The next number after `from` that the run could hold.
  function nextNumber(from) {
    for (var j = from + 1; j < books.length; j++) {
      if (books[j].number !== null && !books[j].flagged) return books[j].number;
    }
    return null;
  }

  var top = null;      // the highest own number in this part
  var offset = 0;      // the whole volumes of every part before this one
  var reached = 0;     // the highest number given so far
  var part = 0;
  for (var k = 0; k < books.length; k++) {
    var n = books[k].number;
    if (n === null) { out.push(side()); continue; }
    // A short-story book counts only as the very next volume (Spice and
    // Wolf's "Side Colors" is volume 11), never as one the run reaches later,
    // and not at the head of the list when the run starts after it.
    if (books[k].flagged) {
      var after = nextNumber(k);
      var ahead = top === null ? after !== null && after <= n : n > top + 1;
      if (ahead) { out.push(side()); continue; }
    }
    // The same number again, unmarked, is the next piece of one volume
    // ("Volume 4 Canto I", "Volume 4 Canto II"), so it isn't caught here.
    if (top !== null && (n < top || (n === top && books[k].flagged))) {
      // The number goes back. A run that starts again at 1 and carries on is
      // a new part; anything else (a short-story book, a "Volume 0", a
      // spin-off) sits outside the run.
      var next = nextNumber(k);
      var newPart = !books[k].flagged
        && (next === null ? n === 1 && books[k].partWords : next > n && next <= top);
      if (!newPart) { out.push(side()); continue; }
      offset = Math.floor(reached);
      top = null;
      part++;
    }
    top = top === null ? n : Math.max(top, n);
    reached = Math.max(reached, offset + n);
    out.push({ number: offset + n, side: false, part: part });
  }
  return out;
}

/**
 * A side book's name, worded so the app reads it as a side story: "side
 * story", "gaiden" or "omake" anywhere, or "extra", "special" or "bonus" at
 * the start. A label that already reads as one is kept; anything else gets
 * "Side story: " in front.
 */
function sideStoryName(label) {
  var named = String(label || '').replace(/^SS\b/, 'Short Stories').replace(/\bVol\b\.?/g, 'Volume');
  return readsAsSideStory(named) ? named : 'Side story: ' + named;
}

function readsAsSideStory(name) {
  var lower = String(name || '').toLowerCase();
  if (/side[\s-]?stor(?:y|ies)|side chapter|gaiden|omake/.test(lower)) return true;
  // "Extra", "Special" and "Bonus" count only at the start, before nothing, a
  // number, punctuation or a word like "story".
  return /^[^a-z0-9]*(?:extras?|specials?|bonus)(?:\s*$|\s*[^a-z\s]|\s+(?:chapter|ch\.|episode|ep|story|stories|part))/.test(lower);
}

/** The volumes from the series page's grid, in its order. */
function volumesFromGrid(doc) {
  var cards = doc.select('section.vol-grid article.card');
  var out = [];
  for (var i = 0; i < cards.length; i++) {
    var links = cards[i].select('a');
    var url = '';
    for (var k = 0; k < links.length && !url; k++) url = bookPath(links[k].attr('href'));
    if (!url) continue;
    var heading = cards[i].selectFirst('.card-title');
    var name = heading ? heading.text() : '';
    if (!name) {
      var labelled = cards[i].selectFirst('a.stretched-link');
      name = labelled ? labelled.attr('aria-label') : '';
    }
    out.push({ url: url, name: String(name || '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * The volumes from the page's structured data, for a page served without the
 * grid. The site lists the same volumes there, each with its position.
 */
function volumesFromData(body) {
  var blocks = String(body || '').match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
  for (var i = 0; i < blocks.length; i++) {
    var data;
    try {
      data = JSON.parse(blocks[i].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
    } catch (e) { continue; }
    var parts = data && data.hasPart;
    if (!parts || !parts.length) continue;
    var sorted = parts.slice().sort(function (a, b) {
      return (parseInt(a.position, 10) || 0) - (parseInt(b.position, 10) || 0);
    });
    var out = [];
    for (var k = 0; k < sorted.length; k++) {
      var url = bookPath(sorted[k].url);
      if (url) out.push({ url: url, name: String(sorted[k].name || '').trim() });
    }
    if (out.length) return out;
  }
  return [];
}

// MARK: - Prose

/**
 * The text of one `<section class="chapter">`, as paragraphs.
 *
 * The section's own heading (`h2.chapter-title`) comes first, once, when the
 * section has any text; the copy of it inside the text is dropped, along with
 * pictures, scripts and styles.
 */
function sectionParagraphs(section, fallbackHeading) {
  var headingMatch = /<h2\b[^>]*class="[^"]*\bchapter-title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(section);
  var heading = headingMatch ? plain(headingMatch[1]) : (fallbackHeading || '');

  var body = section
    .replace(/<(h[1-6]|script|style|picture|figure|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(img|source)\b[^>]*>/gi, ' ');

  var out = [];
  var paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  var match;
  while ((match = paragraph.exec(body)) !== null) {
    var text = plain(match[1]);
    if (text) out.push({ text: text });
  }
  if (out.length && heading) out.unshift({ text: heading });
  return out;
}

/** Table-of-contents titles by section id, for a section without its heading. */
function contents(body) {
  var out = {};
  var nav = /<nav\b[^>]*(?:id="toc-list"|class="[^"]*\btoc-view\b)[^>]*>([\s\S]*?)<\/nav>/i.exec(body);
  if (!nav) return out;
  var link = /<a\b[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = link.exec(nav[1])) !== null) out[match[1]] = plain(match[2]);
  return out;
}

function volumeParagraphs(body) {
  var text = String(body || '');
  var startMatch = /<article\b[^>]*class="[^"]*\bcontent-body\b/i.exec(text);
  var start = startMatch ? startMatch.index : text.indexOf('<main');
  if (start < 0) return [];
  var end = text.lastIndexOf('</article>');
  var article = text.slice(start, end > start ? end : text.length);
  var titles = contents(text);

  var opener = /<section\b[^>]*class="[^"]*\bchapter\b[^"]*"[^>]*>/gi;
  var starts = [];
  var match;
  while ((match = opener.exec(article)) !== null) {
    starts.push({ index: match.index, id: attribute(match[0], 'id') });
  }

  var out = [];
  if (!starts.length) {
    // A volume served without sections: every paragraph in it, in order.
    return sectionParagraphs(article, '');
  }
  for (var i = 0; i < starts.length; i++) {
    var stop = i + 1 < starts.length ? starts[i + 1].index : article.length;
    var section = article.slice(starts[i].index, stop);
    var pieces = sectionParagraphs(section, titles[starts[i].id] || '');
    for (var k = 0; k < pieces.length; k++) out.push(pieces[k]);
  }
  return out;
}

// MARK: - Source

var SourceBundle = {
  /** The library in the site's own order, most read first, twenty at a time. */
  fetchPopular: function (page) {
    return pageOf(library(), page);
  },

  /** The site keeps no list of what changed recently. */
  fetchLatest: function () {
    return [];
  },

  /**
   * The site's own search: a filter over the library.
   *
   * If the whole query finds nothing and it has a subtitle ("Ascendance of a
   * Bookworm: Part 1"), the part before the colon is tried, because the site
   * names its series differently from the catalogues people search with.
   */
  fetchSearch: function (text, page) {
    var query = String(text || '').trim();
    if (!query) return [];
    var rows = library();
    var found = matching(rows, query);
    if (!found.length) {
      var main = query.split(/\s*[:–—]\s+|\s+-\s+/)[0].trim();
      if (main && main !== query && words(main).length >= 2) found = matching(rows, main);
    }
    return pageOf(found, page);
  },

  getMangaDetails: function (url) {
    var path = seriesPath(url);
    if (!path) throw new Error('That is not a series address on this site.');

    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);
    var title = seriesTitle(doc, body);
    if (!title) throw new Error('This site did not send the series page; it may have been removed.');

    var details = { url: path, title: title, status: 'Unknown', genres: [] };

    var cover = coverFrom(doc.selectFirst('.hero-card .cover-wrap img'))
      || coverFrom(doc.selectFirst('.cover-wrap img'))
      || metaContent(body, 'og:image');
    if (cover) details.thumbnailUrl = absolute(cover);

    var author = doc.selectFirst('.hero-card p.author') || doc.selectFirst('p.author');
    if (author && author.text().trim()) details.author = author.text().replace(/\s+/g, ' ').trim();

    var blurb = doc.select('section.desc-box p.description');
    var parts = [];
    for (var i = 0; i < blurb.length; i++) {
      var piece = blurb[i].text().replace(/\s+/g, ' ').trim();
      if (piece) parts.push(piece);
    }
    var description = parts.join('\n\n') || metaContent(body, 'description');
    if (description) details.description = description;

    // The desktop strip, not the mobile one: that one repeats every tag to
    // scroll them in a loop.
    var tags = doc.select('nav.tags-box.desktop a');
    for (var k = 0; k < tags.length; k++) {
      var tag = tags[k].text().replace(/\s+/g, ' ').trim();
      if (tag && details.genres.indexOf(tag) < 0) details.genres.push(tag);
    }
    return details;
  },

  /**
   * Every volume of the series, in one request. See the header note: a volume
   * is a chapter here, numbered by its own volume number (`numberVolumes`),
   * and a book outside the run is named as a side story.
   */
  getChapterList: function (url) {
    var path = seriesPath(url);
    if (!path) throw new Error('That is not a series address on this site.');

    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);
    var series = seriesTitle(doc, body);

    var volumes = volumesFromGrid(doc);
    if (!volumes.length) volumes = volumesFromData(body);
    if (!volumes.length) {
      throw new Error('This site changed how it lists volumes; this source needs updating.');
    }

    var books = booksOf(volumes, series, slugOf(path));
    var numbers = numberVolumes(books);
    var out = [];
    var names = {};
    for (var i = 0; i < books.length; i++) {
      var book = books[i];
      var label = book.label;
      // "Volume 4" at "…-vol-04-5" is 4.5, and says so.
      var says = /^Volume (\d+)$/.exec(label);
      if (says && book.number !== null && parseFloat(says[1]) !== book.number) {
        label = 'Volume ' + book.number;
      }
      // A label that is only "Volume N" says nothing more when the book is a
      // side story or in a later part; the address says which ("SS Vol 1",
      // "Year 2 Volume 1").
      var plain = /^Volume [\d.]+$/.test(label);
      if (plain && (numbers[i].side || numbers[i].part > 0 || names[label.toLowerCase()])) {
        label = book.slugLabel || label;
      }
      var name = numbers[i].side ? sideStoryName(label) : label;
      if (names[name.toLowerCase()] && book.slugLabel) {
        name = numbers[i].side ? sideStoryName(book.slugLabel) : book.slugLabel;
      }
      names[name.toLowerCase()] = true;
      out.push({ url: book.url, name: name, chapterNumber: numbers[i].number });
    }
    return out;
  },

  /**
   * One volume's text, one entry per paragraph, chapter headings included.
   *
   * Never an empty array: the host can't tell that from a volume nobody is
   * allowed to read, and the reader would show a blank page.
   */
  getPageList: function (chapterUrl) {
    var path = bookPath(chapterUrl);
    if (!path) throw new Error('That is not a volume address on this site.');

    var out = volumeParagraphs(host.http.get(host.baseUrl + path));
    if (!out.length) throw new Error('This site sent the volume with no text in it.');
    return out;
  }
};
