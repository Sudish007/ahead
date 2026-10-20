// YouTube Data API v3 path for `type: 'youtube'` sources: one playlistItems request per channel (1 quota unit),
// mapped to the same record shape parseFeed emits so normalization, dedup and scoring are unchanged.
import { ACCEPT, ParseError } from '../http.js';
import { cleanText, parseDate } from '../normalize.js';
import { stripSponsors } from './feed.js';
import { applySelection, isNonEmptyString } from './common.js';

/** 8 s, no retry (see retryable() in http.js): after an API failure the feed fallback's three attempts must still fit the 45 s backstop. */
export const API_TIMEOUT_MS = 8_000;
export const API_MAX_RESULTS = 15;
const API_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]+$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER_TITLES = new Set(['Private video', 'Deleted video']);

/** Uploads playlist id for the feed URL's `channel_id` (`UC…` -> `UU…`); null when the URL carries no valid channel id. */
export function uploadsPlaylistId(feedUrl) {
  let channelId;
  try { channelId = new URL(feedUrl).searchParams.get('channel_id'); } catch { return null; }
  if (!channelId || !CHANNEL_ID_RE.test(channelId)) return null;
  return `UU${channelId.slice(2)}`;
}

/** The request URL; the key travels only here and is rewritten to `key=REDACTED` by http.js wherever a URL reaches a message. */
export function youtubeApiUrl(playlistId, key) {
  return `${API_ENDPOINT}?part=snippet,contentDetails&maxResults=${API_MAX_RESULTS}&playlistId=${playlistId}&key=${encodeURIComponent(key)}`;
}

/** parsePlaylistItems(body, source, ctx) -> { status, items, fetched, kept }; records carry the fields parseFeed emits for YouTube entries, minus signals. */
export function parsePlaylistItems(body, source, ctx) {
  let doc;
  try { doc = JSON.parse(String(body ?? '')); } catch { throw new ParseError('invalid json'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind !== 'youtube#playlistItemListResponse' || !Array.isArray(doc.items)) {
    throw new ParseError('unexpected shape');
  }
  const isMedia = source.category === 'media';
  const out = [];
  doc.items.forEach((entry, nativeIndex) => {
    if (!entry || typeof entry !== 'object') return;
    const snippet = entry.snippet && typeof entry.snippet === 'object' ? entry.snippet : {};
    const details = entry.contentDetails && typeof entry.contentDetails === 'object' ? entry.contentDetails : {};
    const videoId = details.videoId ?? snippet.resourceId?.videoId;
    if (!isNonEmptyString(videoId) || !VIDEO_ID_RE.test(videoId)) return;
    const title = cleanText(snippet.title);
    if (!title || PLACEHOLDER_TITLES.has(title)) return;
    const raw = { nativeIndex, title, url: `https://www.youtube.com/watch?v=${videoId}` };
    const publishedAt = parseDate(details.videoPublishedAt ?? snippet.publishedAt, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    // Same split as summaryFields in feed.js: bodyLength measures the whole cleaned description, the summary stops before `Sponsors:`.
    const description = cleanText(snippet.description);
    const summaryText = isMedia ? stripSponsors(description) : description;
    if (summaryText) raw.summaryText = summaryText;
    if (description) raw.bodyLength = description.length;
    const channel = cleanText(snippet.channelTitle);
    if (channel) raw.authors = [channel];
    out.push(raw);
  });
  return applySelection(out, source, ctx, doc.items.length);
}

/** One Data API request for the channel's uploads playlist. Throws on any failure; runSource then falls back to the feed. */
export async function fetchYoutubeApi(source, ctx) {
  const playlistId = uploadsPlaylistId(source.url);
  if (!playlistId) throw new ParseError('no channel_id in url');
  const res = await ctx.fetchText(youtubeApiUrl(playlistId, ctx.youtubeApiKey), { accept: ACCEPT.json, timeoutMs: API_TIMEOUT_MS });
  const result = parsePlaylistItems(res.text, source, ctx);
  result.httpStatus = res.status;
  result.note = 'api';
  // finalUrl/requestedUrl are deliberately not set: res.finalUrl carries the key and runSource would echo it in a redirect note.
  return result;
}
