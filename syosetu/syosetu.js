/*
 * Syosetu (小説家になろう) — JavaScript source, prose.
 *
 * Why this site and not an English one. Every English translation of a
 * mainstream Japanese light novel is a licensed edition (Yen On, J-Novel Club,
 * Seven Seas), so every site that serves those chapters in English is serving
 * somebody's licensed text. Syosetu is the opposite case: it is the platform
 * the authors themselves publish on, free, and it is where these books started.
 * Re:ゼロから始める異世界生活, 本好きの下剋上, 無職転生, 転生したらスライムだった件,
 * 薬屋のひとりごと, 盾の勇者の成り上がり and 蜘蛛ですが、なにか？ are all still on
 * it, posted by their authors, and all sit in the first twenty of the
 * bookmark-count ranking this source uses for its catalogue. The text is
 * Japanese — that is the trade, and it is the whole trade.
 *
 * Five things about the site shape this relies on, all measured live on
 * 2026-09-17:
 *
 *  - There is a documented public JSON API at api.syosetu.com with no key and
 *    no login, so browsing, search and details touch no markup at all and a
 *    redesign cannot break them. Rows carry title, ncode, author, synopsis,
 *    tags, episode count and dates. Measured: 1,248,873 works indexed.
 *
 *  - The API has no episode list, so chapter lists are the one scrape here.
 *    An index page is `div.p-eplist__sublist` rows and **paginates at 100**:
 *    本好きの下剋上 is 677 episodes over 7 pages, and reading page one only
 *    would list 100 and look perfectly healthy. The last page number comes off
 *    the pager and every page is walked.
 *
 *  - An index page also carries a recommendation block that links *other
 *    works*, which is the sidebar trap AGENTS.md warns about. Every row is
 *    filtered to hrefs under this work's own `/n<code>/` path.
 *
 *  - A 短編 (one-shot) has no index at all: the work URL *is* the text. That
 *    reads as "this work has no chapters", so it is detected and returned as a
 *    single chapter. Roughly one Syosetu work in four is a 短編.
 *
 *  - A chapter is `div.js-novel-text.p-novel__text` holding `<p id="Ln">`
 *    elements. The author's foreword and afterword are *also* `js-novel-text`,
 *    with a `--preface` / `--afterword` modifier, and they are dropped — the
 *    same call Royal Road's source makes. Measured on the first episode of
 *    本好きの下剋上: 53 paragraphs, no images.
 *
 * Two operational notes, both deliberate:
 *
 *  - `robots.txt` says `Crawl-delay: 1` for every agent and disallows nothing,
 *    so the manifest sets `rateLimitMs: 1000` to match. A 677-episode chapter
 *    list therefore takes about seven seconds. Don't lower it to make that
 *    faster; the site asked.
 *
 *  - Adult works live on a **separate host** (novel18.syosetu.com) behind an
 *    age gate, and nothing here ever touches it. That is why this source is
 *    not flagged NSFW: the catalogue it reads cannot return one.
 */

var API = 'https://api.syosetu.com/novelapi/api/';

// Per-work card image. The site renders one for every work and serves it as
// the page's own `og:image` — it is title lettering rather than cover art,
// because a web novel has no cover, and it is what the site has. Verified 200
// with ~120 KB of PNG on every ncode tried.
var CARD_HOST = 'https://sbo.syosetu.com/';

// title, ncode, writer, story, keyword, genre, noveltype, end, episode count,
// last update. Asking for only these keeps a page of twenty down to a few KB.
var FIELDS = 't-n-w-s-k-g-nt-e-ga-gl';

// The host reads `hasNextPage` as "twenty came back", so a browse page must be
// exactly twenty whenever more exist.
var PAGE_SIZE = 20;

// The API refuses `st` above 2000, so browsing stops at page 100 rather than
// returning an error the user would see as the source being broken.
var API_MAX_START = 2000;

// An index page holds 100 episodes. Forty pages is 4,000 episodes — past the
// longest work on the site — and stops a pager that starts pointing at itself
// from walking forever.
var MAX_INDEX_PAGES = 40;

var SELECTORS = {
  row: 'div.p-eplist__sublist',
  rowLink: 'a.p-eplist__subtitle',
  rowUpdated: 'div.p-eplist__update',
  pagerLast: 'a.c-pager__item--last',
  pagerAny: 'a.c-pager__item',
  detailTitle: 'h1.p-novel__title',
  detailAuthor: 'div.p-novel__author a',
  detailSummary: 'div.p-novel__summary',
  // Body, foreword and afterword all carry this class; the modifier on the
  // class attribute is what tells them apart. See proseContainer.
  prose: 'div.js-novel-text',
  proseFallback: 'div.p-novel__text',
  proseLegacy: '#novel_honbun',
  proseParagraph: 'p'
};

// Genre codes onto the site's own genre names, for the detail screen. An
// unknown code is skipped rather than guessed at — the tag list below carries
// the useful detail anyway.
var GENRES = {
  '101': '異世界〔恋愛〕', '102': '現実世界〔恋愛〕',
  '201': 'ハイファンタジー', '202': 'ローファンタジー',
  '301': '純文学', '302': 'ヒューマンドラマ', '303': '歴史',
  '304': '推理', '305': 'ホラー', '306': 'アクション', '307': 'コメディー',
  '401': 'VRゲーム', '402': '宇宙', '403': '空想科学', '404': 'パニック',
  '9901': '童話', '9902': '詩', '9903': 'エッセイ', '9904': 'リプレイ',
  '9801': 'ノンジャンル', '9999': 'その他'
};

// A work carries up to a few dozen author tags. Ten is what a detail screen
// can show without becoming a wall.
var MAX_TAGS = 10;

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

// MARK: - Identifiers

/**
 * The ncode — "n4830bu" — out of any URL for a work or one of its episodes.
 *
 * Always lowercased: the API answers in upper case ("N4830BU") and the site's
 * own paths are lower, so one form has to win or the same work arrives under
 * two URLs and the library stores it twice.
 */
function ncodeFrom(value) {
  var found = host.regex.first('([nN][0-9]+[a-zA-Z]*)', '', String(value || ''));
  return found ? String(found).toLowerCase() : '';
}

function workPath(ncode) {
  return '/' + ncode + '/';
}

function cardUrl(ncode) {
  return CARD_HOST + ncode + '/twitter.png';
}

/**
 * Whether a work is finished.
 *
 * `end` is 1 while a work is still being posted and 0 once it is finished, and
 * a 短編 (`noveltype` 2) is complete by definition. Checked against eight works
 * whose real state is known: 本好きの下剋上, 無職転生, 転生したらスライムだった件 and
 * 蜘蛛ですが、なにか？ all read 0 and all ended years ago; Re:ゼロ, 薬屋のひとりごと,
 * 盾の勇者 and 異世界のんびり農家 all read 1 and are all still running.
 */
function statusFor(row) {
  if (!row) return 'Unknown';
  if (row.noveltype === 2) return 'Completed';
  if (row.end === 0) return 'Completed';
  if (row.end === 1) return 'Ongoing';
  return 'Unknown';
}

// MARK: - The API

function apiUrl(pairs) {
  var parts = ['out=json'];
  for (var i = 0; i < pairs.length; i++) {
    var value = pairs[i][1];
    if (value === '' || value == null) continue;
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(value));
  }
  return API + '?' + parts.join('&');
}

/**
 * The rows of an API response.
 *
 * The first element is `{ allcount: n }` — a header, not a work — and taking
 * it as one gives a first shelf cell with no title and no address.
 */
function apiRows(url) {
  var body = host.http.getJSON(url);
  if (!body || !body.length) return [];
  var out = [];
  for (var i = 1; i < body.length; i++) {
    if (body[i] && body[i].ncode) out.push(body[i]);
  }
  return out;
}

function entryFrom(row) {
  var ncode = ncodeFrom(row.ncode);
  if (!ncode) return null;
  return {
    url: workPath(ncode),
    title: String(row.title || ''),
    thumbnailUrl: cardUrl(ncode),
    status: statusFor(row)
  };
}

function listing(order, word, page) {
  var start = (pageNumber(page) - 1) * PAGE_SIZE + 1;
  // Past the API's own ceiling. An empty page tells the host there is no more,
  // which is true, where an error would read as the source having broken.
  if (start > API_MAX_START) return [];

  var rows = apiRows(apiUrl([
    ['of', FIELDS], ['lim', String(PAGE_SIZE)], ['st', String(start)],
    ['order', order], ['word', word]
  ]));

  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var entry = entryFrom(rows[i]);
    if (!entry || !entry.title || seen[entry.url]) continue;
    seen[entry.url] = true;
    out.push(entry);
  }
  return out;
}

// MARK: - Details

function detailsFromRow(row, ncode) {
  var details = {
    url: workPath(ncode),
    title: String(row.title || ''),
    thumbnailUrl: cardUrl(ncode),
    status: statusFor(row),
    genres: []
  };
  if (row.writer) details.author = String(row.writer);
  if (row.story) details.description = String(row.story);

  var genre = GENRES[String(row.genre)];
  if (genre) details.genres.push(genre);

  // Author tags, space separated. They include the site's content advisories
  // (R15, 残酷な描写あり), which is exactly what a reader wants on this screen.
  var tags = String(row.keyword || '').split(/\s+/);
  for (var i = 0; i < tags.length && details.genres.length < MAX_TAGS; i++) {
    if (tags[i] && details.genres.indexOf(tags[i]) < 0) details.genres.push(tags[i]);
  }
  return details;
}

/**
 * Details read off the work's own page.
 *
 * Only reached when the API returns nothing for an ncode the user already has
 * in their library. The API and the site go down separately, and a title that
 * cannot show its own name is worse than one whose tags are missing.
 */
function detailsFromPage(ncode) {
  var doc = host.html.parse(host.http.get(host.baseUrl + workPath(ncode)));
  var details = { url: workPath(ncode), thumbnailUrl: cardUrl(ncode), status: 'Unknown', genres: [] };

  var heading = doc.selectFirst(SELECTORS.detailTitle);
  if (heading) details.title = heading.text().trim();
  var author = doc.selectFirst(SELECTORS.detailAuthor);
  if (author) details.author = author.text().trim();
  var summary = doc.selectFirst(SELECTORS.detailSummary);
  if (summary) details.description = summary.text().trim();

  if (!details.title) {
    throw new Error('Syosetu did not send this work\'s page; it may have been removed.');
  }
  return details;
}

// MARK: - Chapters

/** The highest `?p=` in the pager, which is how many index pages there are. */
function lastIndexPage(doc) {
  var last = doc.selectFirst(SELECTORS.pagerLast);
  var links = last ? [last] : doc.select(SELECTORS.pagerAny);
  var highest = 1;
  for (var i = 0; i < links.length; i++) {
    var found = host.regex.first('[?&]p=(\\d+)', '', String(links[i].attr('href') || ''));
    var n = parseInt(found, 10);
    if (!isNaN(n) && n > highest) highest = n;
  }
  return Math.min(highest, MAX_INDEX_PAGES);
}

/**
 * "2013/09/23 13:35" — the site posts in JST and says so nowhere, so the zone
 * is written in rather than left to the device's.
 *
 * A revised episode reads "2013/09/24 09:24（2013/09/24 15:46 改稿）"; the first
 * timestamp is when it was posted, which is the one a chapter list means.
 */
function updatedAt(text) {
  var parts = host.regex.all('(\\d{4})/(\\d{2})/(\\d{2})\\s+(\\d{2}):(\\d{2})', '', String(text || ''));
  if (!parts.length) return null;
  var m = parts[0];
  var parsed = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00+09:00');
  return isNaN(parsed) ? null : parsed;
}

/**
 * The episodes on one index page.
 *
 * Rows are filtered to this work's own path. An index page carries a
 * recommendation block linking other works with the same row markup further
 * down, and an unfiltered read puts another author's story into this chapter
 * list — the sidebar failure AGENTS.md records, which returns a perfectly
 * healthy-looking list.
 *
 * The episode number comes from the URL rather than the label, because a
 * Syosetu episode is titled in prose ("プロローグ") and nothing in it looks like
 * a number. The URL's own index is the site's ordering and cannot drift.
 */
function episodesOn(doc, ncode) {
  var prefix = workPath(ncode);
  var rows = doc.select(SELECTORS.row);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var link = rows[i].selectFirst(SELECTORS.rowLink);
    if (!link) continue;
    var href = String(link.attr('href') || '');
    if (href.indexOf(prefix) < 0) continue;

    var found = host.regex.first(prefix.replace(/\//g, '\\/') + '(\\d+)', '', href);
    var number = parseInt(found, 10);
    if (isNaN(number)) continue;

    var updated = rows[i].selectFirst(SELECTORS.rowUpdated);
    out.push({
      url: prefix + number + '/',
      name: link.text().trim() || ('第' + number + '話'),
      chapterNumber: number,
      dateUpload: updated ? updatedAt(updated.text()) : null
    });
  }
  return out;
}

// MARK: - Prose

/**
 * Class names an inline stylesheet hides.
 *
 * Royal Road salts its chapters with a decoy line behind a random hidden
 * class. Syosetu does not do this today; checking costs one regex and the
 * failure it prevents is anti-scraping furniture read out as prose.
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
 * The episode's body, excluding the author's notes.
 *
 * The foreword and afterword carry the same `js-novel-text` class as the body
 * with a `--preface` / `--afterword` modifier, and `HTMLSelector` has no
 * `:not()`, so the modifier is read off the class attribute here. Including
 * them would open every episode of some works on a note from the author rather
 * than on the story, and the saved reading position would mean something
 * different on the day one was added.
 */
function proseContainer(doc) {
  var groups = [SELECTORS.prose, SELECTORS.proseFallback, SELECTORS.proseLegacy];
  for (var g = 0; g < groups.length; g++) {
    var found = doc.select(groups[g]);
    for (var i = 0; i < found.length; i++) {
      var classes = String(found[i].attr('class') || '');
      if (classes.indexOf('--preface') >= 0 || classes.indexOf('--afterword') >= 0) continue;
      return found[i];
    }
  }
  return null;
}

/**
 * One paragraph, read from its markup rather than from its text.
 *
 * Ruby is everywhere in Japanese prose — names, unusual readings, a pun the
 * author wants both halves of — and the host's `text()` puts a space either
 * side of every child element, so `<ruby>灯<rp>（</rp><rt>あか</rt><rp>）</rp></ruby>り`
 * arrives as "灯 （ あか ） り". That is not a crash and not an empty chapter;
 * it is prose with gaps punched through it, on most paragraphs of most works
 * here. Reading the markup keeps the reading attached to its word — 灯（あか）り
 * — which is how print does it.
 *
 * `<rp>` holds the site's own fallback brackets and would double them up, so
 * it goes first. Anything left is stripped, which also decodes entities.
 */
function proseText(node) {
  var markup = typeof node.html === 'function' ? node.html() : '';
  if (!markup) return String(node.text() || '').trim();

  return host.stripTags(
    markup
      .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '')
      .replace(/<rt[^>]*>([\s\S]*?)<\/rt>/gi, '（$1）')
      .replace(/<br\s*\/?>/gi, '')
  ).trim();
}

function paragraphsIn(container, body) {
  var hidden = hiddenClassNames(body);
  var nodes = container.select(SELECTORS.proseParagraph);
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    if (isHidden(nodes[i], hidden)) continue;
    // A blank line between paragraphs is `<p><br /></p>`, which has no text.
    // Kept out: a page holding nothing is a page turn onto an empty screen.
    var text = proseText(nodes[i]);
    if (!text) continue;
    out.push({ text: text });
  }
  return out;
}

// MARK: - Source

var SourceBundle = {
  // Bookmark count, not rating. It is the ranking the long-running mainstream
  // works sit at the top of — every one of the seven named at the top of this
  // file is in the first twenty — where the rating orders favour whatever is
  // being voted on this month.
  fetchPopular: function (page) {
    return listing('favnovelcnt', '', page);
  },

  fetchLatest: function (page) {
    return listing('new', '', page);
  },

  // The API matches a word against titles and synopses, so a query can pull in
  // a work that merely mentions it. Ordering by bookmark count puts the work
  // somebody meant first; the host's own matching does the rest.
  fetchSearch: function (text, page) {
    var query = String(text || '').trim();
    if (!query) return [];
    return listing('favnovelcnt', query, page);
  },

  getMangaDetails: function (url) {
    var ncode = ncodeFrom(url);
    if (!ncode) throw new Error('That is not a Syosetu address.');

    var rows = apiRows(apiUrl([['of', FIELDS], ['lim', '1'], ['ncode', ncode]]));
    if (!rows.length) return detailsFromPage(ncode);
    return detailsFromRow(rows[0], ncode);
  },

  getChapterList: function (url) {
    var ncode = ncodeFrom(url);
    if (!ncode) throw new Error('That is not a Syosetu address.');

    var body = host.http.get(host.baseUrl + workPath(ncode));
    var doc = host.html.parse(body);
    var out = episodesOn(doc, ncode);

    // A 短編 has no index: the work's own page holds the story. Answering with
    // an empty list here would read as a work nobody has posted to yet.
    if (!out.length) {
      if (!proseContainer(doc)) {
        throw new Error('Syosetu changed how it lists episodes; this source needs updating.');
      }
      var heading = doc.selectFirst(SELECTORS.detailTitle);
      return [{
        url: workPath(ncode),
        name: (heading ? heading.text().trim() : '') || '短編',
        chapterNumber: 1,
        dateUpload: null
      }];
    }

    // 100 episodes to a page. Reading only the first returns a list that looks
    // complete and stops two thirds of the way through a long work.
    var pages = lastIndexPage(doc);
    var seen = {};
    for (var s = 0; s < out.length; s++) seen[out[s].url] = true;

    for (var p = 2; p <= pages; p++) {
      var more = episodesOn(host.html.parse(host.http.get(host.baseUrl + workPath(ncode) + '?p=' + p)), ncode);
      if (!more.length) break;
      var added = 0;
      for (var i = 0; i < more.length; i++) {
        if (seen[more[i].url]) continue;
        seen[more[i].url] = true;
        out.push(more[i]);
        added++;
      }
      // A pager pointing back at a page already read would otherwise spin
      // until MAX_INDEX_PAGES, one request each.
      if (!added) break;
    }
    return out;
  },

  /**
   * An episode's prose, one entry per paragraph.
   *
   * Text blocks rather than image addresses: the host reads `{ text: … }` as a
   * page of words, and one paragraph per page is what keeps a saved position
   * meaningful at any text size.
   */
  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.indexOf('http') !== 0 && path.charAt(0) !== '/') path = '/' + path;
    var body = host.http.get(path.indexOf('http') === 0 ? path : host.baseUrl + path);
    var doc = host.html.parse(body);

    var container = proseContainer(doc);
    if (!container) {
      throw new Error('Syosetu did not send this episode\'s text. It may have been removed, or the site has changed.');
    }

    var out = paragraphsIn(container, body);
    // Never an empty array: the host cannot tell that from an episode nobody
    // is allowed to read, and the reader would show a blank page saying
    // nothing about why.
    if (!out.length) {
      throw new Error('Syosetu sent this episode with no text in it.');
    }
    return out;
  }
};
