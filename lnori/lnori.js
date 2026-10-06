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
 *  - **Volume order is the series page's order, not anything in a label.** The
 *    numeric ids don't rise with it (Monogatari's first three are 17860, 17874,
 *    17873), and the labels repeat: A Certain Magical Index lists its two
 *    short-story books as "Volume 1" and "Volume 2" between volumes 13 and 17.
 *    A number read from the label would file those as duplicates of the first
 *    two volumes. Position is the number, and a repeated label is told apart
 *    by its address ("SS Vol 1").
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
  var full = String(name || '').replace(/\s+/g, ' ').trim();
  var prefix = comparable(series);
  var rest = full;
  if (prefix && comparable(full).indexOf(prefix) === 0) {
    rest = full.slice(prefix.length).replace(/^[\s:,\-–—]+/, '').trim();
  }
  // A volume named only by the series name says nothing; the caller names it
  // from its address instead.
  if (!rest) return '';
  if (/^\d/.test(rest)) rest = 'Volume ' + rest;
  return rest;
}

/** "a-certain-magical-index-ss-vol-1" under "a-certain-magical-index" → "SS Vol 1". */
function labelFromSlug(path, seriesSlug) {
  var slug = slugOf(path);
  if (seriesSlug && slug === seriesSlug) return '';
  if (seriesSlug && slug.indexOf(seriesSlug + '-') === 0) slug = slug.slice(seriesSlug.length + 1);
  return slug.split('-').filter(Boolean).map(function (word) {
    if (word.length <= 2 && /^[a-z]+$/.test(word)) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
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
   * is a chapter here, numbered by its place in the site's list.
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

    var out = [];
    var seen = {};
    var labels = {};
    var seriesSlug = slugOf(path);
    for (var i = 0; i < volumes.length; i++) {
      var volume = volumes[i];
      if (seen[volume.url]) continue;
      seen[volume.url] = true;

      var label = volumeLabel(volume.name, series) || labelFromSlug(volume.url, seriesSlug)
        || volume.name || ('Volume ' + (out.length + 1));
      // Index lists its short-story books as "Volume 1" and "Volume 2" in the
      // middle of the main run; the address is what tells them apart.
      if (labels[label.toLowerCase()]) label = labelFromSlug(volume.url, seriesSlug) || label;
      labels[label.toLowerCase()] = true;

      out.push({ url: volume.url, name: label, chapterNumber: out.length + 1 });
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
