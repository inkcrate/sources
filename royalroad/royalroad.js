/*
 * Royal Road — JavaScript source.
 *
 * The first source that serves prose rather than artwork. A chapter comes back
 * as one block of text per paragraph, which is what the host reads as a page,
 * so a "page turn" here is a paragraph and nothing downstream has to change.
 *
 * Three things about the site shape this relies on, all measured against the
 * live site on 2026-09-16:
 *
 *  - Listings are server-rendered `div.fiction-list-item` rows, and a row links
 *    its fiction several times over: once around the cover, once around the
 *    title, on /fictions/latest-updates another five times for the newest
 *    chapters, and — this one is nastier — the collapsed synopsis inside the
 *    row can link *other* fictions entirely. So rows are read one at a time,
 *    identified by their own cover and title anchors, and keyed by fiction id.
 *    Measured: 42 fiction anchors on /fictions/best-rated for 20 fictions, 85
 *    on /fictions/latest-updates for 20. Taking one result per anchor
 *    duplicates every row, titles some of them with a chapter name, and puts a
 *    story somebody mentioned in their blurb on the shelf.
 *
 *  - A fiction page declares its whole chapter list as JSON in a script tag
 *    (`window.chapters`), carrying id, title, date, order, visibility and lock
 *    state. That is read instead of the table for the same reason flamecomics
 *    reads `__NEXT_DATA__`: declared data cannot drift the way markup does, and
 *    it sidesteps the duplicate-anchor problem entirely. Measured: 109 entries
 *    on /fiction/21220/mother-of-learning.
 *
 *  - A chapter's prose is a single `div.chapter-inner.chapter-content` holding
 *    clean `<p>` elements and no images. Author notes sit in their own portlet
 *    outside that container, so scoping to it drops them for free. Measured:
 *    172 paragraphs, ~43,000 characters, zero images.
 *
 * Being a scrape, the listing and prose halves break when the site is
 * redesigned; everything they depend on is a selector in SELECTORS below.
 */

var SELECTORS = {
  listRow: 'div.fiction-list-item',
  // The row's own fiction, in preference order: its heading, then its cover,
  // then whatever it links first. Never just "every link in the row" — see
  // parseListing.
  rowTitleLink: "h2.fiction-title a[href*='/fiction/']",
  rowCoverLink: "figure a[href*='/fiction/']",
  fictionLink: "a[href*='/fiction/']",
  // Listing and detail pages mark the cover the same way.
  cover: "img[data-type='cover']",
  detailTitle: 'h1',
  detailDescription: 'div.description',
  detailTag: 'a.fiction-tag',
  detailLabel: 'span.label',
  detailAuthorMeta: "meta[property='books:author']",
  detailAuthorLink: "a[href*='/profile/']",
  prose: 'div.chapter-inner.chapter-content',
  proseParagraph: 'p',
  // Only used when the JSON blob has gone; see chaptersFromTable.
  tableRow: 'tr[data-url]',
  tableName: 'td a',
  tableTime: 'time'
};

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

// MARK: - Identifiers

function fictionIdFrom(href) {
  return host.regex.first('/fiction/(\\d+)', '', String(href || ''));
}

function fictionSlugFrom(href) {
  return host.regex.first('/fiction/\\d+/([^/?#]+)', '', String(href || ''));
}

/** The canonical `/fiction/<id>/<slug>` path, even when given a chapter URL. */
function fictionPathFrom(href) {
  var id = fictionIdFrom(href);
  if (!id) return '';
  var slug = fictionSlugFrom(href);
  return slug ? '/fiction/' + id + '/' + slug : '/fiction/' + id;
}

function isChapterLink(href) {
  return String(href || '').indexOf('/chapter/') >= 0;
}

/**
 * "mother-of-learning" -> "Mother of Learning".
 *
 * Only a fallback, for a row whose title anchor has moved. The slug loses
 * punctuation and capitalisation, so a real title always wins.
 */
function titleFromSlug(href) {
  var slug = fictionSlugFrom(href);
  if (!slug) return '';
  var words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim().split(' ');
  var out = [];
  for (var i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    out.push(words[i].charAt(0).toUpperCase() + words[i].slice(1));
  }
  return out.join(' ');
}

// Site vocabulary onto SMangaStatus raw values.
function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('complete') >= 0) return 'Completed';
  return 'Unknown';
}

/**
 * The cover's address.
 *
 * Royal Road writes a real `src`, unlike most sites this project reads, but
 * `data-src` is checked first so the source survives the day it starts lazy
 * loading — the failure that shape produces is every title with no artwork,
 * and it looks like the site is down rather than like a bug here.
 */
function coverFrom(image) {
  if (!image) return '';
  var lazy = image.absAttr('data-src');
  if (lazy) return lazy;
  return image.absAttr('src');
}

// MARK: - Listings

/**
 * One row's fiction.
 *
 * The row is asked for its heading link first and its cover link second,
 * because those are the only two anchors guaranteed to point at the row's own
 * story. Reading "the links in this row" instead picks up the five newest
 * chapters on the latest-updates listing — whose text is a chapter name — and
 * any fiction the author happened to mention in the synopsis the row keeps
 * collapsed. That last one shipped a story called "Stray Cat Strut" onto a
 * best-rated page it was only *mentioned* on.
 */
function rowEntry(row) {
  var heading = row.selectFirst(SELECTORS.rowTitleLink);
  var link = heading || row.selectFirst(SELECTORS.rowCoverLink) || row.selectFirst(SELECTORS.fictionLink);
  if (!link) return null;

  var href = link.attr('href');
  if (isChapterLink(href)) return null;
  var id = fictionIdFrom(href);
  if (!id) return null;

  var image = row.selectFirst(SELECTORS.cover) || row.selectFirst('img');
  var title = heading ? heading.text() : '';
  if (!title && image) title = image.attr('alt');
  if (!title) title = titleFromSlug(href);
  if (!title) return null;

  return {
    id: id,
    url: fictionPathFrom(href),
    title: title,
    thumbnailUrl: image ? coverFrom(image) : '',
    status: 'Unknown'
  };
}

function parseListing(html) {
  var rows = host.html.parse(html).select(SELECTORS.listRow);
  var out = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var entry = rowEntry(rows[i]);
    if (!entry || seen[entry.id]) continue;
    seen[entry.id] = true;
    out.push({ url: entry.url, title: entry.title, thumbnailUrl: entry.thumbnailUrl, status: entry.status });
  }
  return out;
}

function listing(path, page) {
  var separator = path.indexOf('?') >= 0 ? '&' : '?';
  return parseListing(host.http.get(host.baseUrl + path + separator + 'page=' + pageNumber(page)));
}

// MARK: - Declared JSON

/**
 * The array literal assigned to `window.<name>` in an inline script.
 *
 * Scanned with bracket matching rather than matched with a regex: a chapter
 * title is free text and one containing `];` would truncate a non-greedy
 * pattern, which fails as a JSON parse error on a page that is perfectly fine.
 * Strings are tracked so a bracket inside a title is not counted as nesting.
 */
function scriptArray(body, name) {
  var text = String(body || '');
  var at = text.indexOf('window.' + name);
  if (at < 0) return null;
  var start = text.indexOf('[', at);
  if (start < 0) return null;

  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = start; i < text.length; i++) {
    var c = text.charAt(i);
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Class names the page hides with `display: none` in an inline stylesheet.
 *
 * Royal Road salts each chapter with a decoy line ("Unauthorized tale usage…")
 * carrying a random class that the head hides. On the chapter measured it is a
 * `<span>` between two paragraphs, so selecting `p` already skips it — this
 * catches the day it arrives as a paragraph instead, rather than reading the
 * anti-piracy notice out to someone as prose.
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

// MARK: - Chapters

/**
 * Whether a chapter row from the blob is one an unauthenticated reader can
 * open.
 *
 * `visible` is the site's own switch for a draft or withdrawn chapter.
 * `isUnlocked: false` and a non-empty `subscriptionTiers` are the two shapes an
 * early-access chapter takes — both answer with a paywall page holding no
 * prose. A tiered chapter that the site itself reports as unlocked is kept,
 * because the site is the authority on that and dropping it would hide a
 * chapter people can read.
 */
function isReadable(row) {
  if (!row || !row.url) return false;
  if (!row.visible) return false;
  if (row.isUnlocked === false) return false;
  var tiers = row.subscriptionTiers;
  var tiered = !!tiers && !(Array.isArray(tiers) && tiers.length === 0);
  return !(tiered && row.isUnlocked !== true);
}

function chaptersFromBlob(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!isReadable(row)) continue;

    var uploaded = Date.parse(row.date);
    // `order` is the site's own 0-based position. It is used verbatim rather
    // than parsed out of the title, because Royal Road chapter names are prose
    // ("Lessons of the Loop") and nothing in them looks like "Ch. 12". Shifted
    // by one so the first chapter is 1: a tracker counts chapters from 1, and
    // finishing the first one must not report 0 read.
    var number = typeof row.order === 'number' ? row.order + 1 : null;

    out.push({
      url: String(row.url),
      name: String(row.title || 'Chapter'),
      chapterNumber: number,
      dateUpload: isNaN(uploaded) ? null : uploaded
    });
  }
  return out;
}

/**
 * The chapter table, read only when the JSON blob has gone.
 *
 * The row carries the chapter's address in `data-url`, so this does not have
 * to pick between the two anchors each row holds — and it cannot pair a row
 * with its neighbour's link, which is the mistake that puts every chapter
 * below a locked one off by one.
 */
function chaptersFromTable(doc) {
  var rows = doc.select(SELECTORS.tableRow);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var url = rows[i].attr('data-url');
    if (!url) continue;

    var label = rows[i].selectFirst(SELECTORS.tableName);
    var time = rows[i].selectFirst(SELECTORS.tableTime);
    var seconds = time ? parseInt(time.attr('unixtime'), 10) : NaN;
    var uploaded = isNaN(seconds) ? (time ? Date.parse(time.attr('datetime')) : NaN) : seconds * 1000;

    out.push({
      url: url,
      name: (label ? label.text() : '') || 'Chapter',
      chapterNumber: out.length + 1,
      dateUpload: isNaN(uploaded) ? null : uploaded
    });
  }
  return out;
}

// MARK: - Source

var SourceBundle = {
  fetchPopular: function (page) {
    return listing('/fictions/best-rated', page);
  },

  fetchLatest: function (page) {
    return listing('/fictions/latest-updates', page);
  },

  fetchSearch: function (text, page) {
    var query = String(text || '').trim();
    if (!query) return [];
    return listing('/fictions/search?title=' + encodeURIComponent(query), page);
  },

  getMangaDetails: function (url) {
    var path = fictionPathFrom(url) || String(url || '');
    var body = host.http.get(host.baseUrl + path);
    var doc = host.html.parse(body);

    var details = { url: path, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

    var cover = doc.selectFirst(SELECTORS.cover);
    if (cover) details.thumbnailUrl = coverFrom(cover);

    // The synopsis is declared as a schema.org Book alongside the page, which
    // is both cleaner than the markup and unaffected by a redesign. It carries
    // HTML, so the tags come off before it reaches the screen.
    var ld = host.regex.first('<script type="application/ld\\+json">([\\s\\S]*?)</script>', '', body);
    if (ld) {
      try {
        var book = JSON.parse(ld);
        if (book && book.description) details.description = host.stripTags(book.description);
        if (!details.title && book && book.name) details.title = String(book.name);
      } catch (e) {
        // Falls through to the markup below.
      }
    }
    if (!details.description) {
      var summary = doc.selectFirst(SELECTORS.detailDescription);
      if (summary) details.description = summary.text();
    }

    var author = doc.selectFirst(SELECTORS.detailAuthorMeta);
    if (author && author.attr('content')) {
      details.author = author.attr('content');
    } else {
      var profile = doc.selectFirst(SELECTORS.detailAuthorLink);
      if (profile && profile.text()) details.author = profile.text();
    }

    var tags = doc.select(SELECTORS.detailTag);
    for (var t = 0; t < tags.length; t++) {
      var tag = tags[t].text();
      if (tag) details.genres.push(tag);
    }

    // "Original"/"Fan Fiction" sits in the same label strip as the status, so
    // every label is read and only the ones that name a status are kept.
    var labels = doc.select(SELECTORS.detailLabel);
    for (var l = 0; l < labels.length; l++) {
      var mapped = statusOf(labels[l].text());
      if (mapped !== 'Unknown') { details.status = mapped; break; }
    }
    return details;
  },

  getChapterList: function (url) {
    var path = fictionPathFrom(url) || String(url || '');
    var body = host.http.get(host.baseUrl + path);

    var raw = scriptArray(body, 'chapters');
    if (raw) {
      var rows;
      try {
        rows = JSON.parse(raw);
      } catch (e) {
        throw new Error('Royal Road sent a chapter list that could not be read.');
      }
      return chaptersFromBlob(rows || []);
    }

    // No blob: read the table, and say so plainly if that has gone too. An
    // empty list here would read as "this story has no chapters yet", which is
    // a real state and the wrong answer for a site that has been redesigned.
    var doc = host.html.parse(body);
    if (!doc.selectFirst(SELECTORS.tableRow)) {
      throw new Error('Royal Road changed how it lists chapters; this source needs updating.');
    }
    return chaptersFromTable(doc);
  },

  /**
   * A chapter's prose, one entry per paragraph.
   *
   * Text blocks, not image URLs: the host reads `{ text: … }` as a page of
   * words. One paragraph per page is what keeps a saved position meaningful at
   * any font size.
   */
  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.indexOf('http') !== 0 && path.charAt(0) !== '/') path = '/' + path;
    var body = host.http.get(path.indexOf('http') === 0 ? path : host.baseUrl + path);
    var doc = host.html.parse(body);

    var container = doc.selectFirst(SELECTORS.prose);
    if (!container) {
      throw new Error('Royal Road did not send this chapter\'s text. It may be locked, or the site has changed.');
    }

    var hidden = hiddenClassNames(body);
    var paragraphs = container.select(SELECTORS.proseParagraph);
    var out = [];
    for (var i = 0; i < paragraphs.length; i++) {
      if (isHidden(paragraphs[i], hidden)) continue;
      var text = String(paragraphs[i].text() || '').trim();
      if (!text) continue;
      out.push({ text: text });
    }

    // Never an empty array: the host cannot tell that apart from a chapter
    // nobody is allowed to read, and the reader would show a blank page with
    // no way to know why.
    if (!out.length) {
      throw new Error('Royal Road sent this chapter with no text in it.');
    }
    return out;
  }
};
