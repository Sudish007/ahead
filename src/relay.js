// Relay path for `viaRelay` sources: fetch through the ahead-relay Cloudflare Worker (relay/) with a direct fallback.
// The six Cloudflare-fronted publishers answer a JS challenge to GitHub-hosted runners; the Worker's egress is not challenged.
import { errorClass, formatDetail } from './http.js';

/** One relay attempt per request (the Worker already retries a 429 and serves stale copies); 15 s + a 20 s direct attempt fit the 45 s backstop. */
export const RELAY_TIMEOUT_MS = 15_000;
/** `x-relay-stale` is the Worker's stored fetchedAt (an ISO string); anything longer or non-printable is cut so the note stays one clean line. */
const STALE_MARKER_CHARS = 40;

/**
 * `{ url, token }` when RELAY_URL and RELAY_TOKEN are both non-blank after trim() (trailing slashes stripped from the URL).
 * Either one blank -> null silently (an unset repository secret renders as ''). A malformed RELAY_URL -> one warn and null:
 * the relay degrades to today's direct fetches like the LLM layer does, it never aborts the run.
 */
export function resolveRelay(env, logger) {
  const rawUrl = typeof env?.RELAY_URL === 'string' ? env.RELAY_URL.trim() : '';
  const token = typeof env?.RELAY_TOKEN === 'string' ? env.RELAY_TOKEN.trim() : '';
  if (!rawUrl || !token) return null;
  let parsed = null;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    logger?.warn?.('relay disabled: RELAY_URL must be an https URL without credentials, query or fragment');
    return null;
  }
  return { url: rawUrl.replace(/\/+$/, ''), token };
}

export function relayFeedUrl(relay, sourceId) {
  return `${relay.url}/feed/${encodeURIComponent(sourceId)}`;
}

export function relayPageUrl(relay, sourceId, pageUrl) {
  return `${relay.url}/page/${encodeURIComponent(sourceId)}?u=${encodeURIComponent(pageUrl)}`;
}

/** The `x-relay-stale` value as printable ASCII, trimmed, at most 40 chars ('' when nothing printable remains); undefined without the header. */
export function staleMarker(headers) {
  const raw = headers?.get?.('x-relay-stale');
  if (raw === undefined || raw === null) return undefined;
  // eslint-disable-next-line no-control-regex
  return String(raw).replace(/[^\x20-\x7e]/g, '').trim().slice(0, STALE_MARKER_CHARS);
}

/**
 * fetchText for one `viaRelay` source. `source.url` goes to `/feed/<id>`, every other URL (sitemap article pages) to
 * `/page/<id>?u=`; the relay gets one attempt within RELAY_TIMEOUT_MS (a page keeps its shorter 8 s timeout), and the
 * result's finalUrl is the URL the caller asked for, so runSource never notes `redirected to <relay url>`. Any thrown error
 * (401/404/5xx, timeout, network, body too large) is logged and the direct fetch runs with the caller's options, so the
 * relay can never make a source worse than today. Only the primary (feed/sitemap) request shapes `state.primary`, hence the
 * note; a page that fails on both paths becomes a slug-titled item inside parseSitemap as before.
 */
export function createRelayFetch({ source, relay, direct, logger, state }) {
  return async function relayFetch(url, opts = {}) {
    const primary = url === source.url;
    const relayUrl = primary ? relayFeedUrl(relay, source.id) : relayPageUrl(relay, source.id, url);
    const timeoutMs = Math.min(opts.timeoutMs ?? RELAY_TIMEOUT_MS, RELAY_TIMEOUT_MS);
    try {
      const res = await direct(relayUrl, { ...opts, timeoutMs });
      if (primary) {
        const stale = staleMarker(res.headers);
        state.primary = stale === undefined ? { via: 'relay' } : { via: 'relay', stale };
      }
      return { ...res, finalUrl: url };
    } catch (err) {
      const failure = errorClass(err);
      if (primary) state.primary = { via: 'direct', failure };
      const detail = formatDetail(err?.detail);
      logger.warn(`${source.id}: relay failed (${failure}) for ${primary ? 'feed' : 'page'}; falling back to direct${detail ? ` [${detail}]` : ''}`);
      return direct(url, opts);
    }
  };
}

/** `via relay` | `via relay (stale <fetchedAt>)` | `relay: <class>, fell back to direct`; undefined when no primary request ran. */
export function relayNote(state) {
  const primary = state?.primary;
  if (!primary) return undefined;
  if (primary.via === 'relay') {
    if (primary.stale === undefined) return 'via relay';
    return primary.stale ? `via relay (stale ${primary.stale})` : 'via relay (stale)';
  }
  return `relay: ${primary.failure}, fell back to direct`;
}
