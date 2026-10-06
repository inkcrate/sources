/*
 * MangaDex — JavaScript source.
 *
 * Runtime notes:
 *  - JavaScriptCore only. There is no `fetch`, no `XMLHttpRequest`, no timers.
 *    All network access goes through the injected `host.http` shim.
 *  - Every exported function is SYNCHRONOUS. `host.http.getJSON` blocks this
 *    source's dedicated JS thread and returns the parsed body; returning a
 *    Promise would hand the host an object it cannot read.
 *  - The host derives `hasNextPage` from `results.length >= 20`, so browse
 *    functions must page in twenties.
 */

var PAGE_SIZE = 20;
var COVER_BASE = 'https://uploads.mangadex.org/covers';
var LANG = 'en';

// Widening this would surface adult covers in Discover
// with no way for the reader to opt out.
var CONTENT_RATINGS = ['safe', 'suggestive'];

// MARK: - Helpers

function query(pairs) {
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function contentRatingPairs() {
  var pairs = [];
  for (var i = 0; i < CONTENT_RATINGS.length; i++) {
    pairs.push(['contentRating[]', CONTENT_RATINGS[i]]);
  }
  return pairs;
}

/**
 * Trailing UUID of a `/manga/<uuid>` or `/chapter/<uuid>` path.
 *
 * Empty segments are dropped so a trailing slash doesn't yield "".
 * `String.prototype.split` keeps empty pieces, and without the filter a
 * perfectly good URL is reported as having no id.
 */
function identifier(url) {
  var parts = String(url || '').split('/').filter(function (part) {
    return part.length > 0;
  });
  return parts.length ? parts[parts.length - 1] : '';
}

/** MangaDex localizes strings as {"en": …, "ja-ro": …}. */
function localized(map, preferring) {
  if (!map) return null;
  if (map[preferring]) return map[preferring];
  if (map.en) return map.en;
  // Romanized keys read better than the native script.
  for (var key in map) {
    if (Object.prototype.hasOwnProperty.call(map, key) && key.length > 3 && key.slice(-3) === '-ro') {
      return map[key];
    }
  }
  for (var first in map) {
    if (Object.prototype.hasOwnProperty.call(map, first)) return map[first];
  }
  return null;
}

/** Must return a raw value of `SMangaStatus`, not MangaDex's own vocabulary. */
function statusOf(raw) {
  switch (raw) {
    case 'ongoing': return 'Ongoing';
    case 'completed': return 'Finished';
    case 'hiatus': return 'On Hiatus';
    case 'cancelled': return 'Completed';
    default: return 'Unknown';
  }
}

function relationship(entity, type) {
  var rels = entity.relationships || [];
  for (var i = 0; i < rels.length; i++) {
    if (rels[i].type === type) return rels[i];
  }
  return null;
}

function decodeManga(entity) {
  var attributes = entity.attributes || {};

  var title = localized(attributes.title, LANG) || 'Untitled';

  var altTitles = [];
  var rawAlts = attributes.altTitles || [];
  for (var i = 0; i < rawAlts.length; i++) {
    for (var key in rawAlts[i]) {
      if (Object.prototype.hasOwnProperty.call(rawAlts[i], key)) {
        altTitles.push(rawAlts[i][key]);
        break;
      }
    }
  }

  var cover = relationship(entity, 'cover_art');
  var coverFile = cover && cover.attributes ? cover.attributes.fileName : null;
  // `.512.jpg` is MangaDex's pre-rendered thumbnail — full covers are several MB.
  var thumbnailUrl = coverFile ? COVER_BASE + '/' + entity.id + '/' + coverFile + '.512.jpg' : null;

  var author = relationship(entity, 'author');
  var artist = relationship(entity, 'artist');

  var genres = [];
  var tags = attributes.tags || [];
  for (var t = 0; t < tags.length; t++) {
    var tagName = tags[t].attributes ? localized(tags[t].attributes.name, 'en') : null;
    if (tagName) genres.push(tagName);
  }

  return {
    url: '/manga/' + entity.id,
    title: title,
    altTitles: altTitles,
    author: author && author.attributes ? author.attributes.name : null,
    artist: artist && artist.attributes ? artist.attributes.name : null,
    description: localized(attributes.description, LANG),
    genres: genres,
    status: statusOf(attributes.status),
    thumbnailUrl: thumbnailUrl
  };
}

/**
 * Every cover MangaDex keeps for a title, as `getCovers` returns them: one per
 * volume and language, in the order asked for (newest volume first). The same
 * `.512.jpg` thumbnail as the title's own cover.
 */
function decodeCovers(mangaId, entities) {
  var out = [];
  for (var i = 0; i < entities.length; i++) {
    var attributes = entities[i].attributes || {};
    if (!attributes.fileName) continue;
    out.push({
      url: COVER_BASE + '/' + mangaId + '/' + attributes.fileName + '.512.jpg',
      volume: attributes.volume || null,
      language: attributes.locale || null
    });
  }
  return out;
}

function decodeChapter(entity) {
  var attributes = entity.attributes || {};

  // Licensed titles list chapters that live on another site and carry no pages.
  // Surfacing them gives the reader an empty chapter — and, because MangaDex
  // counts them under `hasAvailableChapters`, it is also why such titles reach
  // the browse feed at all. Dropping them here is the only place it can be done.
  if (attributes.externalUrl || !(attributes.pages > 0)) return null;

  var label = 'Chapter ' + (attributes.chapter || '?');
  if (attributes.volume) label = 'Vol.' + attributes.volume + ' ' + label;
  if (attributes.title) label += ' - ' + attributes.title;

  var group = relationship(entity, 'scanlation_group');
  var published = attributes.publishAt ? Date.parse(attributes.publishAt) : NaN;

  return {
    url: '/chapter/' + entity.id,
    name: label,
    chapterNumber: attributes.chapter ? parseFloat(attributes.chapter) || 0 : 0,
    scanlator: group && group.attributes ? group.attributes.name : null,
    // The host divides by 1000; `Date.parse` already yields milliseconds.
    dateUpload: isNaN(published) ? null : published
  };
}

function browse(page, extraPairs) {
  var pairs = [
    ['limit', String(PAGE_SIZE)],
    ['offset', String(Math.max(0, page - 1) * PAGE_SIZE)],
    ['hasAvailableChapters', 'true'],
    ['availableTranslatedLanguage[]', LANG],
    ['includes[]', 'cover_art'],
    ['includes[]', 'author'],
    ['includes[]', 'artist']
  ].concat(contentRatingPairs(), extraPairs || []);

  var response = host.http.getJSON(host.baseUrl + '/manga' + query(pairs));
  var out = [];
  var data = response.data || [];
  for (var i = 0; i < data.length; i++) out.push(decodeManga(data[i]));
  return out;
}

// MARK: - Exported source

var SourceBundle = {
  fetchPopular: function (page) {
    return browse(page, [['order[followedCount]', 'desc']]);
  },

  fetchLatest: function (page) {
    return browse(page, [['order[latestUploadedChapter]', 'desc']]);
  },

  fetchSearch: function (q, page) {
    var extra = [['order[relevance]', 'desc']];
    var trimmed = String(q || '').replace(/^\s+|\s+$/g, '');
    if (trimmed) extra.push(['title', trimmed]);
    return browse(page, extra);
  },

  getMangaDetails: function (url) {
    var id = identifier(url);
    if (!id) throw new Error('MangaDex: no id in ' + url);

    var pairs = [
      ['includes[]', 'cover_art'],
      ['includes[]', 'author'],
      ['includes[]', 'artist']
    ];
    var response = host.http.getJSON(host.baseUrl + '/manga/' + id + query(pairs));
    if (!response.data) throw new Error('MangaDex: no manga ' + id);
    return decodeManga(response.data);
  },

  getChapterList: function (url) {
    var id = identifier(url);
    if (!id) throw new Error('MangaDex: no id in ' + url);

    var chapters = [];
    var offset = 0;
    var limit = 500;

    // The feed is paginated; a long series needs several passes. Capped at the
    // 5,000 so a pathological title can't spin here.
    while (true) {
      var pairs = [
        ['limit', String(limit)],
        ['offset', String(offset)],
        ['translatedLanguage[]', LANG],
        ['order[chapter]', 'asc'],
        ['includes[]', 'scanlation_group']
      ].concat(contentRatingPairs());

      var response = host.http.getJSON(host.baseUrl + '/manga/' + id + '/feed' + query(pairs));
      var data = response.data || [];
      for (var i = 0; i < data.length; i++) {
        var chapter = decodeChapter(data[i]);
        if (chapter) chapters.push(chapter);
      }

      offset += limit;
      if (!response.total || offset >= response.total || offset >= 5000) break;
    }

    return chapters;
  },

  getPageList: function (chapterUrl) {
    var id = identifier(chapterUrl);
    if (!id) throw new Error('MangaDex: no id in ' + chapterUrl);

    // Licensed titles are the trap here. `decodeChapter` drops the obvious
    // ones — no pages, or an `externalUrl` pointing at the publisher — but a
    // licensed chapter can still list a page count and then 404 when its
    // images are requested, because MangaDex keeps the entry and removes the
    // files. One Piece is exactly this: the feed says fourteen pages and
    // /at-home/server returns "not found".
    //
    // There is no way to tell before asking, so the failure has to explain
    // itself. The default would surface "Manga not found on source" over the
    // page the reader is trying to open, which is both wrong and useless.
    var res = host.http.tryGet(host.baseUrl + '/at-home/server/' + id);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("MangaDex lists this chapter but doesn't host its pages — that usually means the title is licensed. Try another source.");
      }
      throw new Error(res.error || ('MangaDex returned HTTP ' + res.status));
    }

    var response = JSON.parse(res.body);
    var chapter = response.chapter || {};
    var files = chapter.data || [];
    if (!files.length) throw new Error('MangaDex returned no pages for this chapter.');

    var prefix = response.baseUrl + '/data/' + chapter.hash;
    var pages = [];
    for (var i = 0; i < files.length; i++) pages.push(prefix + '/' + files[i]);
    return pages;
  },

  // Optional. One request; the hundred newest is every volume of all but the
  // very longest series, and the newest is what matters.
  getCovers: function (url) {
    var id = identifier(url);
    if (!id) throw new Error('MangaDex: no id in ' + url);

    var pairs = [
      ['manga[]', id],
      ['limit', '100'],
      ['order[volume]', 'desc']
    ];
    var response = host.http.getJSON(host.baseUrl + '/cover' + query(pairs));
    return decodeCovers(id, response.data || []);
  }
};
