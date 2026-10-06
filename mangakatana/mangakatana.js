/*
 * MangaKatana — JavaScript source.
 *
 * Server-rendered HTML, with one wrinkle: the reader keeps its page list in a
 * JavaScript array whose **variable name changes** between pages. Matching on
 * that name would work once and then quietly return nothing, so the pages are
 * found by their image host instead, which is distinct from every other URL
 * on the page.
 *
 * The other trap is the listing heading, which reads
 * `"Some Title - Update chapter 2"` — the update note is a sibling of the
 * link, so the anchor's text is the title and the heading's is not.
 *
 * Search has three answers that aren't a results page, and each used to be
 * read wrong (see `fetchSearch`):
 * - exactly one match redirects straight to that title's page;
 * - no match at all is a 404;
 * - a search within about three seconds of the last one from the same
 *   connection answers 200 with an empty body. Measured 2026-09-24: searches
 *   spaced 3s apart all answered, spaced under ~2.5s most came back empty.
 *   Only search is held back this way; title pages and listings answer at
 *   any speed.
 */

var SELECTORS = {
  listingRow: 'div#book_list div.item',
  listingLink: "a[href*='/manga/']",
  listingTitle: 'h3.title',
  cover: 'img',
  status: 'div.status',
  detailTitle: 'h1',
  detailSummary: 'div.summary',
  metaRow: 'ul.meta li',
  metaLabel: 'div.label',
  metaValue: 'div.value',
  chapterRow: 'div.chapters table tr',
  chapterLink: "a[href*='/manga/']",
  chapterDate: 'div.update_time'
};

// The host's wording for its two failures that aren't the site failing. A
// failed request only reaches the bundle as a message (`tryGet` reports
// status 0 for every failure), so the message is all there is to go on. If
// the app ever rewords them, search falls back to throwing, which is what it
// did before, so nothing gets worse.
var NOT_FOUND = /doesn.t have this/i;
var NOTHING_BACK = /sent nothing back/i;

// Enough tries to outlast the site's search spacing. The host already spaces
// this source's requests half a second apart and a held-back answer takes
// under 0.2s, so ten tries cover about five seconds. The live test needed
// four to six after a search made just before.
var SEARCH_TRIES = 10;

// The reader's images all come from a numbered subdomain; nothing else on the
// page does.
var PAGE_URL = 'https://i\\d+\\.mangakatana\\.com/[^"\'\\s,\\]]+';

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/** "aishiteru-uso-dakedo.10797" — slug and id together. */
function slugFrom(url) {
  return host.regex.first('/manga/([^/?#]+)', '', String(url || ''))
    || String(url || '').replace(/^\/+/, '');
}

/**
 * What `row.select(selector)` gives each row, from one lookup over the list.
 *
 * Every lookup inside a node goes back to the host with the whole page, so a
 * lookup in every row costs rows × page size, and a long series ran past the
 * host's time limit at about 640 rows. Each node arrives knowing its place in
 * the page (`path`), so one lookup over `scope` is shared out to the rows that
 * hold each match: the same nodes, in the same order, as asking row by row.
 * Nodes without a place fall back to asking row by row.
 */
function selectInRows(scope, rows, selector) {
  if (!rows.length) return [];
  var found = hasPaths(rows) ? scope.select(selector) : null;
  if (!found || !hasPaths(found)) {
    return rows.map(function (row) { return row.select(selector); });
  }

  var groups = [];
  var rowsAt = {};
  for (var i = 0; i < rows.length; i++) {
    groups.push([]);
    var at = rows[i].path.join('.');
    (rowsAt[at] = rowsAt[at] || []).push(i);
  }
  for (var f = 0; f < found.length; f++) {
    var path = found[f].path;
    var key = '';
    // Each enclosing row, outermost first. A node is never inside itself.
    for (var d = 0; d < path.length - 1; d++) {
      key += (d ? '.' : '') + path[d];
      var holders = Object.prototype.hasOwnProperty.call(rowsAt, key) ? rowsAt[key] : null;
      for (var h = 0; holders && h < holders.length; h++) groups[holders[h]].push(found[f]);
    }
  }
  return groups;
}

function hasPaths(nodes) {
  for (var i = 0; i < nodes.length; i++) {
    var path = nodes[i].path;
    if (!path || typeof path.join !== 'function') return false;
  }
  return true;
}

function statusOf(text) {
  var value = String(text || '').toLowerCase();
  if (value.indexOf('ongoing') >= 0) return 'Ongoing';
  if (value.indexOf('completed') >= 0) return 'Completed';
  if (value.indexOf('cancel') >= 0 || value.indexOf('hiatus') >= 0) return 'Unknown';
  return 'Unknown';
}

function parseListing(html) {
  var rows = host.html.parse(html).select(SELECTORS.listingRow);
  var out = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var heading = row.selectFirst(SELECTORS.listingTitle);
    // The anchor, not the heading: the heading also holds a
    // "- Update chapter 2" note that would end up in every title.
    var link = heading ? heading.selectFirst('a') : row.selectFirst(SELECTORS.listingLink);
    if (!link) continue;

    var slug = slugFrom(link.attr('href'));
    var title = link.text();
    if (!slug || !title || seen[slug]) continue;
    seen[slug] = true;

    var status = row.selectFirst(SELECTORS.status);
    out.push({
      url: '/manga/' + slug,
      title: title,
      thumbnailUrl: (function () {
        var image = row.selectFirst(SELECTORS.cover);
        return image ? image.absAttr('src') : '';
      })(),
      status: status ? statusOf(status.text()) : 'Unknown'
    });
  }
  return out;
}

/** Everything the title page says about a title. */
function readTitlePage(doc, slug) {
  var details = { url: '/manga/' + slug, status: 'Unknown', genres: [] };

  var heading = doc.selectFirst(SELECTORS.detailTitle);
  if (heading) details.title = heading.text();

  var summary = doc.selectFirst(SELECTORS.detailSummary);
  if (summary) details.description = summary.text();

  var cover = doc.selectFirst('div.cover ' + SELECTORS.cover) || doc.selectFirst(SELECTORS.cover);
  if (cover) details.thumbnailUrl = cover.absAttr('src');

  // Label/value rows with no class naming the field, so matched on wording.
  var rows = doc.select(SELECTORS.metaRow);
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i].selectFirst(SELECTORS.metaLabel);
    var value = rows[i].selectFirst(SELECTORS.metaValue);
    if (!label || !value) continue;
    var name = label.text().toLowerCase();

    if (name.indexOf('alt name') >= 0) {
      // "ドメスティックな彼女 ; Domestic Girlfriend ; …"
      var alts = value.text().split(';');
      details.altTitles = [];
      for (var a = 0; a < alts.length; a++) {
        var alt = alts[a].replace(/^\s+|\s+$/g, '');
        if (alt) details.altTitles.push(alt);
      }
    } else if (name.indexOf('author') >= 0) {
      details.author = value.text();
    } else if (name.indexOf('genre') >= 0) {
      var links = value.select('a');
      for (var g = 0; g < links.length; g++) {
        var genre = links[g].text();
        if (genre) details.genres.push(genre);
      }
    } else if (name.indexOf('status') >= 0) {
      details.status = statusOf(value.text());
    }
  }
  return details;
}

/**
 * The one title a search answered with, when the site skipped the results
 * page and went straight to it. Null when the page is anything else.
 *
 * Told apart by the page itself — a title heading and a chapter table, and
 * no results grid — with the address it landed on as the preferred source of
 * the title's slug. The canonical link is the fallback, for a host that
 * doesn't report where a redirect ended up.
 */
function titlePageResult(html, finalUrl) {
  var doc = host.html.parse(html);
  if (doc.selectFirst(SELECTORS.listingRow) || doc.selectFirst('div#book_list')) return null;
  if (!doc.selectFirst('h1.heading') || !doc.selectFirst('div.chapters')) return null;

  var slug = host.regex.first('^https?://[^/]+/manga/([^/?#]+)', '', String(finalUrl || ''));
  if (!slug) {
    var canonical = doc.selectFirst("link[rel='canonical']") || doc.selectFirst("meta[property='og:url']");
    var href = canonical ? (canonical.attr('href') || canonical.attr('content')) : '';
    slug = host.regex.first('/manga/([^/?#]+)', '', String(href || ''));
  }
  if (!slug) return null;

  var details = readTitlePage(doc, slug);
  return details.title ? details : null;
}

/**
 * Fetches a search page, or null when the site says there are no matches.
 *
 * Retries only the empty "slow down" answer. Everything else that fails —
 * a block, a timeout, a search the app stopped waiting for — throws at once
 * with the host's own message, exactly as `host.http.get` would.
 */
function searchResponse(url) {
  for (var attempt = 0; attempt < SEARCH_TRIES; attempt++) {
    var res = host.http.tryGet(url) || {};
    if (res.ok && res.body) return res;

    var error = res.ok ? 'The source sent nothing back.' : String(res.error || ('HTTP ' + (res.status || 0)));
    // The site's own "no results" page comes with a 404.
    if (NOT_FOUND.test(error)) return null;
    if (!NOTHING_BACK.test(error)) throw new Error(error);
    // Asked again too soon after the last search. Ask again: the host's
    // spacing between tries is the wait.
  }
  // Still held back after about five seconds: something else on this
  // connection is searching the site too. Said plainly rather than as "sent
  // nothing back", which reads as the site being broken.
  throw new Error('The site is asking us to slow down. Try again in a moment.');
}

var SourceBundle = {
  fetchPopular: function (page) {
    return parseListing(host.http.get(host.baseUrl + '/manga/page/' + pageNumber(page)));
  },

  fetchLatest: function (page) {
    return parseListing(host.http.get(host.baseUrl + '/latest/page/' + pageNumber(page)));
  },

  fetchSearch: function (text, page) {
    var res = searchResponse(
      host.baseUrl + '/page/' + pageNumber(page)
      + '?search=' + encodeURIComponent(text) + '&search_by=book_name'
    );
    if (!res) return [];

    // A unique match lands on the title's own page, which has no result rows.
    var rows = parseListing(res.body);
    if (rows.length) return rows;
    var only = titlePageResult(res.body, res.url);
    return only ? [only] : [];
  },

  getMangaDetails: function (url) {
    var slug = slugFrom(url);
    return readTitlePage(host.html.parse(host.http.get(host.baseUrl + '/manga/' + slug)), slug);
  },

  getChapterList: function (url) {
    var slug = slugFrom(url);
    var doc = host.html.parse(host.http.get(host.baseUrl + '/manga/' + slug));
    var rows = doc.select(SELECTORS.chapterRow);
    // One lookup each for the whole page, not two in every row: see
    // selectInRows.
    var links = selectInRows(doc, rows, SELECTORS.chapterLink);
    var dates = selectInRows(doc, rows, SELECTORS.chapterDate);

    var out = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var link = links[i][0] || null;
      if (!link) continue;
      var href = String(link.attr('href') || '');
      var path = host.regex.first('(/manga/[^?#]+)', '', href);
      if (!path || path === '/manga/' + slug || seen[path]) continue;
      seen[path] = true;

      var when = dates[i][0] || null;
      var parsed = when ? Date.parse(when.text()) : NaN;
      var name = link.text();

      out.push({
        url: path,
        name: name || path,
        chapterNumber: parseFloat(host.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: isNaN(parsed) ? null : parsed
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var body = host.http.get(host.baseUrl + path);

    // Matched by image host rather than by the array's variable name, which
    // differs from page to page.
    var matches = host.regex.all(PAGE_URL, '', body);
    var out = [];
    var seen = {};
    for (var i = 0; i < matches.length; i++) {
      var url = matches[i][0];
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push({ url: url });
    }
    return out;
  }
};
