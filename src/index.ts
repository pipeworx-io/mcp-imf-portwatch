interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * IMF PortWatch MCP — global maritime trade & chokepoint signals (free, no auth)
 *
 * PortWatch is the IMF's open dashboard for tracking shipping activity, port
 * disruptions, and chokepoint throughput. Data is published daily as ArcGIS
 * FeatureServer layers — we surface the four most-useful ones for live
 * geopolitical / trade bet research:
 *
 * - chokepoints_list:        the 8 major chokepoints (Suez, Panama, Hormuz,
 *                            Bab-el-Mandeb, Bosphorus, Malacca, Gibraltar,
 *                            Cape of Good Hope) with annual traffic mix
 * - chokepoint_daily_traffic: per-chokepoint vessel counts by day —
 *                            this is the signal for "Suez transits dropped
 *                            from 70/day to 30/day post-Houthi attacks"
 * - port_search:             1500+ named ports with country / trade share
 * - recent_disruptions:      port-affecting events (cyclones, floods,
 *                            conflicts) with alert level and impact area
 * - chokepoint_status:       decision-grade read on one chokepoint — latest
 *                            settled day vs a trailing baseline, per-vessel-type
 *                            deviation, and an explicit publication-lag note
 * - chokepoint_compare:      the same deviation math across 2-6 chokepoints,
 *                            ranked by how anomalous each one is
 *
 * PUBLICATION LAG: PortWatch's daily chokepoint layer is not real time. As of
 * 2026-07-27 the newest settled row was 2026-07-19 — roughly an 8-day lag. Every
 * tool that returns a "latest" day reports data_lag_days and a freshness_note so
 * downstream agents never present these counts as a live vessel feed.
 *
 * Source: https://portwatch.imf.org (open ArcGIS FeatureServer; no key).
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'IMF Portwatch');
}


const BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services';

// Friendly-name → portid map for the major chokepoints. PortWatch's
// portid scheme (chokepoint1..28) is not memorable and the numbering is
// non-obvious (e.g. chokepoint7 is Cape of Good Hope, not Hormuz), so
// we accept names and translate. Mapping reflects the actual PortWatch
// portid assignment as of 2026-05. If you add an alias for a chokepoint
// not below, the resolver also falls back to a portname LIKE search.
const CHOKEPOINT_ALIASES: Record<string, string> = {
  suez: 'chokepoint1', 'suez canal': 'chokepoint1',
  panama: 'chokepoint2', 'panama canal': 'chokepoint2',
  bosphorus: 'chokepoint3', bosporus: 'chokepoint3', 'bosphorus strait': 'chokepoint3', 'bosporus strait': 'chokepoint3',
  'bab-el-mandeb': 'chokepoint4', 'bab el mandeb': 'chokepoint4', 'bab al-mandab': 'chokepoint4', 'bab al-mandab strait': 'chokepoint4',
  malacca: 'chokepoint5', 'strait of malacca': 'chokepoint5', 'malacca strait': 'chokepoint5',
  hormuz: 'chokepoint6', 'strait of hormuz': 'chokepoint6',
  'cape of good hope': 'chokepoint7', 'good hope': 'chokepoint7',
  gibraltar: 'chokepoint8', 'strait of gibraltar': 'chokepoint8', 'gibraltar strait': 'chokepoint8',
  dover: 'chokepoint9', 'strait of dover': 'chokepoint9', 'dover strait': 'chokepoint9', 'english channel': 'chokepoint9',
  // Secondary chokepoints — same scheme, less commonly cited
  oresund: 'chokepoint10', 'oresund strait': 'chokepoint10',
  taiwan: 'chokepoint11', 'taiwan strait': 'chokepoint11',
  korea: 'chokepoint12', 'korea strait': 'chokepoint12',
  tsugaru: 'chokepoint13', 'tsugaru strait': 'chokepoint13',
  luzon: 'chokepoint14', 'luzon strait': 'chokepoint14',
  lombok: 'chokepoint15', 'lombok strait': 'chokepoint15',
  ombai: 'chokepoint16', 'ombai strait': 'chokepoint16',
  bohai: 'chokepoint17', 'bohai strait': 'chokepoint17',
  torres: 'chokepoint18', 'torres strait': 'chokepoint18',
  sunda: 'chokepoint19', 'sunda strait': 'chokepoint19',
  makassar: 'chokepoint20', 'makassar strait': 'chokepoint20',
  magellan: 'chokepoint21', 'magellan strait': 'chokepoint21',
  yucatan: 'chokepoint22', 'yucatan channel': 'chokepoint22',
  windward: 'chokepoint23', 'windward passage': 'chokepoint23',
  mona: 'chokepoint24', 'mona passage': 'chokepoint24',
  balabac: 'chokepoint25', 'balabac strait': 'chokepoint25',
  bering: 'chokepoint26', 'bering strait': 'chokepoint26',
  mindoro: 'chokepoint27', 'mindoro strait': 'chokepoint27',
  kerch: 'chokepoint28', 'kerch strait': 'chokepoint28',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'chokepoints_list',
    description:
      'List the 8 major maritime chokepoints PortWatch tracks (Suez, Panama, Bosphorus, Gibraltar, Dover, Malacca, Hormuz, Bab-el-Mandeb) with annual vessel counts, traffic mix by cargo type (container / dry bulk / tanker / RoRo / general), and top industries by volume. Use to discover what a chokepoint normally carries — for live daily throughput call chokepoint_daily_traffic.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chokepoint_daily_traffic',
    description:
      'Daily vessel counts and aggregate capacity (deadweight tonnage) transiting a specific chokepoint. Returns time series ordered most-recent-first, with per-cargo-type breakdown (container / dry bulk / general cargo / RoRo / tanker). Use for "is Suez traffic back to normal after the Houthi attacks", "Hormuz throughput vs 30d average", or any bet predicated on a chokepoint disruption persisting. Accepts friendly names (suez / panama / hormuz / bab-el-mandeb / etc.) or PortWatch portid (chokepoint1..8).',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoint: { type: 'string', description: 'Friendly name (e.g. "Hormuz", "Suez Canal") or portid ("chokepoint7")' },
        days: { type: 'number', description: 'Lookback window in days (default 30, max 365). Data is daily.' },
      },
      required: ['chokepoint'],
    },
  },
  {
    name: 'port_search',
    description:
      'Search the PortWatch port database (1,500+ ports globally) by name, country, or ISO3. Returns matching ports with country, continent, latitude/longitude, annual vessel counts by cargo type, top industries, and the port\'s share of the country\'s maritime imports/exports. Useful for identifying which ports would be affected by a country-level disruption, or finding the LOCODE / portid for a named port.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text portname match (e.g. "Rotterdam", "Houston", "Singapore")' },
        country: { type: 'string', description: 'Country filter — full name ("Netherlands") or ISO3 ("NLD")' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'recent_disruptions',
    description:
      'Port-affecting disruption events tracked by PortWatch — tropical cyclones, floods, earthquakes, conflict events — with start/end dates, alert level (GREEN/ORANGE/RED), severity, affected port count, and impacted population. Filter by country, alert level, or year. Use for "what disrupted shipping in the last month", "which port closures hit our supply chain", or to validate a bet on whether a current disruption is escalating.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to a single country name (e.g. "Mozambique")' },
        alert_level: { type: 'string', description: 'RED | ORANGE | GREEN — minimum alert level to include' },
        year: { type: 'number', description: 'Filter to events from this calendar year' },
        limit: { type: 'number', description: 'Max events to return (default 25, max 100)' },
      },
    },
  },
  {
    name: 'chokepoint_status',
    description:
      'Chokepoint traffic status for one maritime chokepoint: the most recent settled day of vessel transits scored against a trailing baseline, so an agent can tell at a glance whether shipping through that strait or canal is above, below, or at its normal run rate. Answers "is shipping through the Strait of Hormuz down", "Suez Canal transit volume this week", "Panama Canal ship counts vs normal", "maritime chokepoint disruption check", "tanker traffic anomaly at Bab el-Mandeb". Returns the latest day (total vessels, per-vessel-type counts, aggregate capacity in deadweight tonnage), data_lag_days plus a freshness_note, the baseline mean with delta / percent deviation / direction (above, below, normal), 7-day and 30-day means, the same percent deviation per vessel type (tanker, container, dry_bulk, general_cargo, roro — a tanker-only drop at Hormuz is the tradeable signal), and the min and max daily total in the window with their dates. Source is IMF PortWatch daily AIS-derived transit counts, published with a multi-day lag, so the "latest" day is the most recent settled day rather than a live count. Accepts forgiving names — "Hormuz", "Strait of Hormuz", "hormuz", "Suez", "Panama", "Bab el-Mandeb", "Malacca", "Taiwan", "Bosphorus", "Gibraltar", "Dover" — or a PortWatch portid like "chokepoint6". Examples: chokepoint_status({chokepoint: "Hormuz"}); chokepoint_status({chokepoint: "Suez Canal", baseline_days: 30}); chokepoint_status({chokepoint: "Panama"}).',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoint: { type: 'string', description: 'Chokepoint name, alias, or portid — e.g. "Hormuz", "Strait of Hormuz", "Suez Canal", "Bab el-Mandeb", "chokepoint6"' },
        baseline_days: { type: 'number', description: 'Length of the trailing baseline window in days, measured backward from the day before the latest settled day (default 90, min 7, max 364).' },
      },
      required: ['chokepoint'],
    },
  },
  {
    name: 'chokepoint_compare',
    description:
      'Compare chokepoint traffic status across 2 to 6 maritime chokepoints side by side and rank them by how far each one has deviated from its own trailing baseline, so an agent can spot which strait or canal is the anomalous one. Answers "which maritime chokepoint is disrupted right now", "Suez Canal transit volume vs Bab el-Mandeb", "compare Panama Canal ship counts to Hormuz", "tanker traffic anomaly across chokepoints". For each chokepoint returns the latest settled day and its total, the baseline mean over the window, the delta, the percent deviation, the direction (above, below, normal), and the per-vessel-type percent deviation; results are sorted with the largest absolute deviation first. Reports data_lag_days and a freshness_note for the whole comparison. Source is IMF PortWatch daily AIS-derived transit counts, published with a multi-day lag, so every "latest" figure is the most recent settled day rather than a live count. Names are matched forgivingly ("Hormuz", "Strait of Hormuz", "Suez", "Panama", "Bab el-Mandeb", "Malacca", "Taiwan", "Bosphorus", "Gibraltar", "Dover") or accept a portid. Examples: chokepoint_compare({chokepoints: ["Hormuz", "Suez", "Bab el-Mandeb"]}); chokepoint_compare({chokepoints: ["Suez", "Cape of Good Hope"], days: 90}); chokepoint_compare({chokepoints: ["Panama", "Suez", "Malacca", "Hormuz"], days: 14}).',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two to six chokepoint names, aliases, or portids — e.g. ["Hormuz", "Suez", "Bab el-Mandeb"]',
        },
        days: { type: 'number', description: 'Length of the trailing baseline window in days for every chokepoint (default 30, min 7, max 364).' },
      },
      required: ['chokepoints'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'chokepoints_list':
      return chokepointsList();
    case 'chokepoint_daily_traffic':
      return chokepointDailyTraffic(
        reqStr(args, 'chokepoint', '"Hormuz"'),
        clamp((args.days as number) ?? 30, 1, 365),
      );
    case 'port_search':
      return portSearch(
        args.query as string | undefined,
        args.country as string | undefined,
        clamp((args.limit as number) ?? 20, 1, 100),
      );
    case 'recent_disruptions':
      return recentDisruptions(
        args.country as string | undefined,
        args.alert_level as string | undefined,
        args.year as number | undefined,
        clamp((args.limit as number) ?? 25, 1, 100),
      );
    case 'chokepoint_status':
      return chokepointStatus(
        reqStr(args, 'chokepoint', '"Hormuz"'),
        clamp((args.baseline_days as number) ?? 90, 7, 364),
      );
    case 'chokepoint_compare':
      return chokepointCompare(
        reqStrArray(args, 'chokepoints', '["Hormuz", "Suez", "Bab el-Mandeb"]'),
        clamp((args.days as number) ?? 30, 7, 364),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Implementations ──────────────────────────────────────────────────

type EsriFeature<T = Record<string, unknown>> = { attributes: T };
type EsriResponse<T = Record<string, unknown>> = { features?: EsriFeature<T>[]; error?: { code?: number; message?: string } };

async function esriQuery<T = Record<string, unknown>>(
  service: string,
  params: Record<string, string>,
): Promise<EsriResponse<T>> {
  const url = `${BASE}/${service}/FeatureServer/0/query?${new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'json',
    ...params,
  })}`;
  // Cache 15 min at the CF edge — PortWatch updates daily and the same
  // chokepoint queries get hammered when multiple agents resolve the
  // same bet. Errors get a short TTL so transient failures don't pin.
  const res = await pwFetch(url, {
    cf: {
      cacheTtlByStatus: { '200-299': 900, '400-499': 30, '500-599': 5 },
      cacheEverything: true,
    },
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`PortWatch ArcGIS error: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await parseJson<unknown>(res, 'IMF PortWatch')) as EsriResponse<T>;
  if (body.error) {
    throw new Error(`PortWatch query error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body;
}

interface ChokepointAttrs {
  portid: string;
  portname: string;
  fullname: string;
  lat: number;
  lon: number;
  vessel_count_total: number;
  vessel_count_container: number;
  vessel_count_dry_bulk: number;
  vessel_count_general_cargo: number;
  vessel_count_RoRo: number;
  vessel_count_tanker: number;
  industry_top1: string;
  industry_top2: string;
  industry_top3: string;
}

async function chokepointsList() {
  const body = await esriQuery<ChokepointAttrs>('PortWatch_chokepoints_database', {
    orderByFields: 'portid ASC',
  });
  const feats = body.features ?? [];
  return {
    source: 'IMF PortWatch — annual aggregates',
    count: feats.length,
    chokepoints: feats.map((f) => {
      const a = f.attributes;
      return {
        portid: a.portid,
        name: a.portname,
        full_name: a.fullname,
        lat: a.lat,
        lon: a.lon,
        annual_vessel_count_total: a.vessel_count_total,
        annual_by_cargo_type: {
          container: a.vessel_count_container,
          dry_bulk: a.vessel_count_dry_bulk,
          general_cargo: a.vessel_count_general_cargo,
          roro: a.vessel_count_RoRo,
          tanker: a.vessel_count_tanker,
        },
        top_industries: [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean),
        // Convenience: include the friendly-name aliases that resolve to this portid
        friendly_aliases: Object.entries(CHOKEPOINT_ALIASES)
          .filter(([, id]) => id === a.portid)
          .map(([alias]) => alias),
      };
    }),
  };
}

interface ChokepointDailyAttrs {
  date: string;
  portid: string;
  portname: string;
  n_container: number;
  n_dry_bulk: number;
  n_general_cargo: number;
  n_roro: number;
  n_tanker: number;
  n_cargo: number;
  n_total: number;
  capacity_container: number;
  capacity_dry_bulk: number;
  capacity_general_cargo: number;
  capacity_roro: number;
  capacity_tanker: number;
  capacity_cargo: number;
  capacity: number;
}

/**
 * Resolve a user-supplied chokepoint string to a PortWatch portid.
 * Resolution order: alias map → raw portid → portname LIKE fallback.
 * The fallback rescues names not in the alias map (or if IMF re-numbers
 * chokepoints in the future) by doing a server-side LIKE on portname.
 * Returns null when nothing matches — callers surface unknownChokepoint().
 */
async function resolveChokepoint(chokepoint: string): Promise<string | null> {
  const key = chokepoint.toLowerCase().trim();
  const direct = CHOKEPOINT_ALIASES[key] ?? (/^chokepoint\d+$/.test(key) ? key : null);
  if (direct) return direct;
  // Strip the leading article/geographic prefix agents commonly attach
  // ("the Strait of Hormuz", "Bab el Mandeb Strait") before the LIKE fallback,
  // and normalise separators so "bab el-mandeb" and "bab el mandeb" agree.
  const normalised = key
    .replace(/^the\s+/, '')
    .replace(/\b(strait|straits|canal|channel|passage)\b/g, ' ')
    .replace(/\bof\b/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalised && normalised !== key) {
    const aliasHit =
      CHOKEPOINT_ALIASES[normalised] ??
      CHOKEPOINT_ALIASES[normalised.replace(/\s+/g, '-')] ??
      null;
    if (aliasHit) return aliasHit;
  }
  const probe = normalised || key;
  const safe = probe.replace(/'/g, "''").toUpperCase();
  const fallback = await esriQuery<{ portid: string; portname: string }>('PortWatch_chokepoints_database', {
    where: `UPPER(portname) LIKE '%${safe}%'`,
    outFields: 'portid,portname',
    resultRecordCount: '1',
  });
  return fallback.features?.[0]?.attributes.portid ?? null;
}

/** Uniform, actionable "I don't know that chokepoint" payload. */
function unknownChokepoint(input: string) {
  return {
    found: false,
    reason: 'unknown_chokepoint' as const,
    input,
    valid_chokepoints: KNOWN_CHOKEPOINT_NAMES,
    hint: `Unknown chokepoint "${input}". Pass one of: ${KNOWN_CHOKEPOINT_NAMES.join(', ')} — or a PortWatch portid like "chokepoint1". Call chokepoints_list for the full 28-chokepoint set with annual traffic mix.`,
  };
}

interface DailyRow {
  date: string;
  n_total: number;
  n_container: number;
  n_dry_bulk: number;
  n_general_cargo: number;
  n_roro: number;
  n_tanker: number;
  capacity_dwt: number;
}

/**
 * Fetch a chokepoint's daily series, NEWEST FIRST.
 *
 * The ArcGIS layer is asked for `date DESC`, but we never trust the server's
 * ordering: re-sorting here defensively is what keeps every mean, extreme, and
 * "latest" below correct even if the upstream ever returns rows unordered or
 * ascending. `date` comes back as an esriFieldTypeDateOnly string ("2026-07-19"),
 * so a plain lexicographic compare is a correct chronological compare.
 */
async function fetchDailySeries(portid: string, rows: number): Promise<{ portname: string | null; series: DailyRow[] }> {
  // PortWatch ArcGIS layers can return at most 2000 rows per page; 365d
  // is well under that for a single chokepoint.
  const body = await esriQuery<ChokepointDailyAttrs>('Daily_Chokepoints_Data', {
    where: `portid='${portid}'`,
    orderByFields: 'date DESC',
    resultRecordCount: String(rows),
  });
  const feats = body.features ?? [];
  const series = feats
    .map((f) => {
      const a = f.attributes;
      return {
        date: a.date,
        n_total: a.n_total,
        n_container: a.n_container,
        n_dry_bulk: a.n_dry_bulk,
        n_general_cargo: a.n_general_cargo,
        n_roro: a.n_roro,
        n_tanker: a.n_tanker,
        capacity_dwt: a.capacity,
      };
    })
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { portname: feats[0]?.attributes.portname ?? null, series };
}

async function chokepointDailyTraffic(chokepoint: string, days: number) {
  const portid = await resolveChokepoint(chokepoint);
  if (!portid) return unknownChokepoint(chokepoint);
  const { portname, series } = await fetchDailySeries(portid, days);
  if (series.length === 0) {
    return { found: false, reason: 'no_data', portid, hint: 'PortWatch may not have populated data for this chokepoint yet.' };
  }
  // Headline stats: latest day + 7d/30d averages for quick momentum read.
  const totals = series.map((s) => s.n_total);
  const last7 = totals.slice(0, Math.min(7, totals.length));
  const last30 = totals.slice(0, Math.min(30, totals.length));
  return {
    source: 'IMF PortWatch — daily vessel transits',
    portid,
    portname,
    days_returned: series.length,
    latest: series[0],
    data_lag_days: dataLagDays(series[0].date),
    freshness_note: freshnessNote(series[0].date),
    summary: {
      avg_vessels_7d: +avg(last7).toFixed(1),
      avg_vessels_30d: +avg(last30).toFixed(1),
      // 7d vs 30d ratio surfaces momentum: <0.85 = recent slowdown,
      // >1.15 = recent surge. Same shape as our other momentum signals.
      recent_vs_baseline_ratio: avg(last30) > 0 ? +(avg(last7) / avg(last30)).toFixed(3) : null,
    },
    series,
  };
}

// ── Chokepoint status / compare ──────────────────────────────────────
//
// Both tools share one shape: take the most recent SETTLED day, score it
// against a trailing baseline that EXCLUDES that day, and always disclose the
// publication lag. Traders settle markets on these counts, so "latest" must
// never read as "live".

const VESSEL_TYPES = [
  { key: 'tanker', field: 'n_tanker' },
  { key: 'container', field: 'n_container' },
  { key: 'dry_bulk', field: 'n_dry_bulk' },
  { key: 'general_cargo', field: 'n_general_cargo' },
  { key: 'roro', field: 'n_roro' },
] as const;

// Deviations inside ±5% are noise on a daily vessel count, not a signal.
const NORMAL_BAND_PCT = 5;

interface Deviation {
  latest: number;
  baseline_mean: number;
  delta_vs_baseline: number;
  pct_vs_baseline: number | null;
  direction: 'above' | 'below' | 'normal' | 'no_baseline';
}

/** Score one latest value against a baseline mean. */
function deviation(latest: number, baselineValues: number[]): Deviation {
  const baseMean = avg(baselineValues);
  const delta = latest - baseMean;
  if (baseMean <= 0) {
    return {
      latest,
      baseline_mean: round(baseMean, 2),
      delta_vs_baseline: round(delta, 2),
      pct_vs_baseline: null,
      // A zero baseline makes a percentage meaningless (divide by zero); the
      // absolute delta is still reported so the caller keeps the raw signal.
      direction: 'no_baseline',
    };
  }
  const pct = (delta / baseMean) * 100;
  return {
    latest,
    baseline_mean: round(baseMean, 2),
    delta_vs_baseline: round(delta, 2),
    pct_vs_baseline: round(pct, 2),
    direction: Math.abs(pct) < NORMAL_BAND_PCT ? 'normal' : pct > 0 ? 'above' : 'below',
  };
}

/**
 * Split a NEWEST-FIRST series into the latest settled day and the trailing
 * baseline window immediately before it.
 */
function splitBaseline(series: DailyRow[], baselineDays: number) {
  const latest = series[0];
  const baseline = series.slice(1, baselineDays + 1);
  return { latest, baseline };
}

async function chokepointStatus(chokepoint: string, baselineDays: number) {
  const portid = await resolveChokepoint(chokepoint);
  if (!portid) return unknownChokepoint(chokepoint);
  // +1 row so the baseline window can exclude the latest day and still be
  // `baselineDays` long. 365 is the layer's full retained history.
  const { portname, series } = await fetchDailySeries(portid, Math.min(365, baselineDays + 1));
  if (series.length === 0) {
    return { found: false, reason: 'no_data', portid, input: chokepoint, hint: 'PortWatch has no daily rows for this chokepoint yet.' };
  }
  const { latest, baseline } = splitBaseline(series, baselineDays);
  const baselineTotals = baseline.map((r) => r.n_total);
  const totals = series.map((r) => r.n_total);

  const trend = deviation(latest.n_total, baselineTotals);
  const byVesselTypeTrend: Record<string, Deviation> = {};
  for (const { key, field } of VESSEL_TYPES) {
    byVesselTypeTrend[key] = deviation(latest[field], baseline.map((r) => r[field]));
  }

  // Extremes over the whole fetched window (latest day included).
  let minRow = series[0];
  let maxRow = series[0];
  for (const r of series) {
    if (r.n_total < minRow.n_total) minRow = r;
    if (r.n_total > maxRow.n_total) maxRow = r;
  }

  const lag = dataLagDays(latest.date);
  return {
    source: 'IMF PortWatch — daily chokepoint vessel transits (AIS-derived)',
    portid,
    portname,
    chokepoint_input: chokepoint,
    latest: {
      date: latest.date,
      n_total: latest.n_total,
      by_vessel_type: {
        tanker: latest.n_tanker,
        container: latest.n_container,
        dry_bulk: latest.n_dry_bulk,
        general_cargo: latest.n_general_cargo,
        roro: latest.n_roro,
      },
      capacity_dwt: latest.capacity_dwt,
    },
    data_lag_days: lag,
    freshness_note: freshnessNote(latest.date),
    window: {
      baseline_days_requested: baselineDays,
      baseline_days_used: baseline.length,
      baseline_start: baseline.length > 0 ? baseline[baseline.length - 1].date : null,
      baseline_end: baseline.length > 0 ? baseline[0].date : null,
      note: 'Baseline is the trailing window ending the day before the latest settled day; the latest day is not part of its own baseline.',
    },
    trend: {
      baseline_mean_total: trend.baseline_mean,
      delta_vs_baseline: trend.delta_vs_baseline,
      pct_vs_baseline: trend.pct_vs_baseline,
      direction: trend.direction,
      mean_7d: round(avg(totals.slice(0, Math.min(7, totals.length))), 2),
      mean_30d: round(avg(totals.slice(0, Math.min(30, totals.length))), 2),
      normal_band_pct: NORMAL_BAND_PCT,
    },
    by_vessel_type_trend: byVesselTypeTrend,
    recent_extremes: {
      window_days: series.length,
      window_start: series[series.length - 1].date,
      window_end: series[0].date,
      min: { date: minRow.date, n_total: minRow.n_total },
      max: { date: maxRow.date, n_total: maxRow.n_total },
    },
  };
}

async function chokepointCompare(chokepoints: string[], days: number) {
  const inputs = chokepoints.map((c) => String(c).trim()).filter(Boolean);
  if (inputs.length < 2 || inputs.length > 6) {
    throw new Error(
      `chokepoint_compare needs between 2 and 6 chokepoints, received ${inputs.length}. Pass e.g. ["Hormuz", "Suez", "Bab el-Mandeb"].`,
    );
  }

  const settled = await Promise.all(
    inputs.map(async (input) => {
      const portid = await resolveChokepoint(input);
      if (!portid) return { input, portid: null, portname: null, series: [] as DailyRow[] };
      const { portname, series } = await fetchDailySeries(portid, Math.min(365, days + 1));
      return { input, portid, portname, series };
    }),
  );

  const notFound = settled.filter((s) => !s.portid).map((s) => unknownChokepoint(s.input));
  const noData = settled.filter((s) => s.portid && s.series.length === 0).map((s) => ({ input: s.input, portid: s.portid, reason: 'no_data' }));

  const rows = settled
    .filter((s) => s.portid && s.series.length > 0)
    .map((s) => {
      const { latest, baseline } = splitBaseline(s.series, days);
      const dev = deviation(latest.n_total, baseline.map((r) => r.n_total));
      const byType: Record<string, number | null> = {};
      for (const { key, field } of VESSEL_TYPES) {
        byType[key] = deviation(latest[field], baseline.map((r) => r[field])).pct_vs_baseline;
      }
      return {
        chokepoint_input: s.input,
        portid: s.portid,
        portname: s.portname,
        latest_date: latest.date,
        latest_total: latest.n_total,
        latest_by_vessel_type: {
          tanker: latest.n_tanker,
          container: latest.n_container,
          dry_bulk: latest.n_dry_bulk,
          general_cargo: latest.n_general_cargo,
          roro: latest.n_roro,
        },
        baseline_mean_total: dev.baseline_mean,
        baseline_days_used: baseline.length,
        delta_vs_baseline: dev.delta_vs_baseline,
        pct_vs_baseline: dev.pct_vs_baseline,
        direction: dev.direction,
        pct_vs_baseline_by_vessel_type: byType,
      };
    })
    // Most anomalous first — that ranking is the whole point of the tool.
    .sort((a, b) => Math.abs(b.pct_vs_baseline ?? 0) - Math.abs(a.pct_vs_baseline ?? 0));

  // The lag is uniform across the layer, but take the oldest "latest" date so
  // the disclosed lag is never optimistic.
  const oldestLatest = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.latest_date < acc ? r.latest_date : acc),
    null,
  );
  const mostAnomalous = rows.find((r) => r.direction === 'above' || r.direction === 'below') ?? null;

  return {
    source: 'IMF PortWatch — daily chokepoint vessel transits (AIS-derived)',
    compared: rows.length,
    baseline_days: days,
    data_lag_days: oldestLatest ? dataLagDays(oldestLatest) : null,
    freshness_note: oldestLatest
      ? freshnessNote(oldestLatest)
      : 'IMF PortWatch publishes daily chokepoint counts with a multi-day lag; no settled day was returned for these chokepoints.',
    normal_band_pct: NORMAL_BAND_PCT,
    ranking_note: 'Sorted by the absolute size of the deviation from each chokepoint\'s own trailing baseline — the first row is the most anomalous.',
    most_anomalous: mostAnomalous
      ? {
          portname: mostAnomalous.portname,
          pct_vs_baseline: mostAnomalous.pct_vs_baseline,
          direction: mostAnomalous.direction,
        }
      : null,
    chokepoints: rows,
    unresolved: notFound.length > 0 ? notFound : undefined,
    no_data: noData.length > 0 ? noData : undefined,
  };
}

interface PortAttrs {
  portid: string;
  portname: string;
  country: string;
  ISO3: string;
  continent: string;
  fullname: string;
  lat: number;
  lon: number;
  LOCODE: string;
  vessel_count_total: number;
  vessel_count_container: number;
  vessel_count_tanker: number;
  vessel_count_dry_bulk: number;
  industry_top1: string;
  industry_top2: string;
  industry_top3: string;
  share_country_maritime_import: number;
  share_country_maritime_export: number;
}

async function portSearch(query: string | undefined, country: string | undefined, limit: number) {
  const where: string[] = [];
  if (query) {
    // ArcGIS LIKE with case-insensitive — use UPPER on both sides.
    const safe = query.replace(/'/g, "''");
    where.push(`UPPER(portname) LIKE '%${safe.toUpperCase()}%'`);
  }
  if (country) {
    const safe = country.replace(/'/g, "''");
    // Try both ISO3 (3-char) and country name
    if (/^[A-Z]{3}$/i.test(country)) {
      where.push(`ISO3='${safe.toUpperCase()}'`);
    } else {
      where.push(`UPPER(country) LIKE '%${safe.toUpperCase()}%'`);
    }
  }
  const whereClause = where.length > 0 ? where.join(' AND ') : '1=1';
  const body = await esriQuery<PortAttrs>('PortWatch_ports_database', {
    where: whereClause,
    orderByFields: 'vessel_count_total DESC',
    resultRecordCount: String(limit),
  });
  const feats = body.features ?? [];
  return {
    source: 'IMF PortWatch — port reference (annual aggregates)',
    matched: feats.length,
    ports: feats.map((f) => {
      const a = f.attributes;
      return {
        portid: a.portid,
        portname: a.portname,
        full_name: a.fullname,
        country: a.country,
        iso3: a.ISO3,
        continent: a.continent,
        locode: a.LOCODE,
        lat: a.lat,
        lon: a.lon,
        annual_vessels: a.vessel_count_total,
        annual_by_cargo: {
          container: a.vessel_count_container,
          tanker: a.vessel_count_tanker,
          dry_bulk: a.vessel_count_dry_bulk,
        },
        top_industries: [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean),
        country_maritime_import_share: a.share_country_maritime_import,
        country_maritime_export_share: a.share_country_maritime_export,
      };
    }),
  };
}

interface DisruptionAttrs {
  eventid: number;
  eventtype: string;
  eventname: string;
  htmlname: string;
  alertlevel: string;
  country: string;
  fromdate: number; // epoch ms
  todate: number;   // epoch ms
  year: number;
  severitytext: string;
  lat: number;
  long: number;
  affectedports: string;
  n_affectedports: number;
  affectedpopulation: string;
}

const ALERT_PRIORITY: Record<string, number> = { GREEN: 1, ORANGE: 2, RED: 3 };

async function recentDisruptions(
  country: string | undefined,
  alertLevel: string | undefined,
  year: number | undefined,
  limit: number,
) {
  const where: string[] = [];
  if (country) {
    const safe = country.replace(/'/g, "''");
    where.push(`UPPER(country) LIKE '%${safe.toUpperCase()}%'`);
  }
  if (year && Number.isFinite(year)) {
    where.push(`year=${Math.floor(year)}`);
  }
  // alertlevel filter applies as a minimum (RED-or-higher etc.)
  const minPri = alertLevel ? (ALERT_PRIORITY[alertLevel.toUpperCase()] ?? 1) : 0;
  const whereClause = where.length > 0 ? where.join(' AND ') : '1=1';
  const body = await esriQuery<DisruptionAttrs>('portwatch_disruptions_database', {
    where: whereClause,
    orderByFields: 'fromdate DESC',
    resultRecordCount: String(Math.min(200, limit * 3)),
  });
  let feats = body.features ?? [];
  if (minPri > 0) {
    feats = feats.filter((f) => (ALERT_PRIORITY[(f.attributes.alertlevel ?? '').toUpperCase()] ?? 0) >= minPri);
  }
  feats = feats.slice(0, limit);
  return {
    source: 'IMF PortWatch — port-affecting disruption events',
    matched: feats.length,
    disruptions: feats.map((f) => {
      const a = f.attributes;
      return {
        eventid: a.eventid,
        type: a.eventtype,
        name: a.eventname ?? a.htmlname,
        alert_level: a.alertlevel,
        country: a.country,
        from_date: a.fromdate ? new Date(a.fromdate).toISOString().slice(0, 10) : null,
        to_date: a.todate ? new Date(a.todate).toISOString().slice(0, 10) : null,
        severity: a.severitytext,
        lat: a.lat,
        lon: a.long,
        affected_ports_count: a.n_affectedports,
        affected_population: a.affectedpopulation,
      };
    }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / arr.length : 0;
}

function round(n: number, dp: number): number {
  return Number.isFinite(n) ? +n.toFixed(dp) : 0;
}

/**
 * Whole days between an ISO date-only string ("2026-07-19") and today, UTC.
 * Both sides are pinned to UTC midnight so the answer never wobbles with the
 * caller's local timezone.
 */
function dataLagDays(isoDate: string): number | null {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((todayUtc - t) / 86400000));
}

/**
 * REQUIRED on any payload exposing a "latest" day. PortWatch is a settled daily
 * publication, not a live AIS feed — saying so explicitly is what stops an agent
 * from quoting these counts as real-time vessel traffic.
 */
function freshnessNote(isoDate: string): string {
  const lag = dataLagDays(isoDate);
  const lagText = lag === null ? 'a multi-day' : `a ~${lag}-day`;
  return `IMF PortWatch publishes daily chokepoint transit counts with ${lagText} lag; ${isoDate} is the most recent settled day, not a live count. Treat it as the latest published observation rather than current vessel traffic.`;
}

/** Canonical display names offered back when a chokepoint name fails to resolve. */
const KNOWN_CHOKEPOINT_NAMES = [
  'Suez Canal', 'Panama Canal', 'Bosphorus Strait', 'Bab el-Mandeb', 'Strait of Malacca',
  'Strait of Hormuz', 'Cape of Good Hope', 'Strait of Gibraltar', 'Strait of Dover',
  'Oresund Strait', 'Taiwan Strait', 'Korea Strait', 'Tsugaru Strait', 'Luzon Strait',
  'Lombok Strait', 'Ombai Strait', 'Bohai Strait', 'Torres Strait', 'Sunda Strait',
  'Makassar Strait', 'Magellan Strait', 'Yucatan Channel', 'Windward Passage',
  'Mona Passage', 'Balabac Strait', 'Bering Strait', 'Mindoro Strait', 'Kerch Strait',
];

function reqStrArray(args: Record<string, unknown>, key: string, example: string): string[] {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) {
    // Tolerate a single name or a comma-separated string — agents send both.
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`Required argument "${key}" missing. Pass an array of strings like ${example}.`);
  }
  const out = v.map((s) => String(s).trim()).filter(Boolean);
  if (out.length === 0) {
    throw new Error(`Argument "${key}" was empty. Pass an array of strings like ${example}.`);
  }
  return out;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function clamp(n: number | undefined, lo: number, hi: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
