// api.worker.js — 取得安定化版 v4
// Endpoints:
//   /api/v1/search?q={keyword}(&type=channel|video|playlist)(&more=N)
//   /api/v1/shorts/{videoId}(&light=1)   /api/v1/shorts?more=N
//   /api/v1/videos/{videoId}(&light=1)
//   /api/v1/channels/{channelId|@handle}(&videos&shorts&live&playlists)(&more=N)
//   /api/v1/comments/{videoId}
//   light=1 : 関連動画の取得を省略 (related は [])
//   partial / errors : 一部取得できなかった時に付く (不完全な結果はキャッシュしない)

const YT = "https://www.youtube.com/youtubei/v1";

// 通常は WEB。動画の配信情報 (streamingData) が欠けた時だけ ANDROID で再取得する
const WEB = {
  context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "ja", gl: "JP" } },
  headers: { "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": "2.20250101.00.00" },
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
};
const ANDROID = {
  context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "ja", gl: "JP" } },
  headers: { "X-YouTube-Client-Name": "3", "X-YouTube-Client-Version": "19.09.37" },
  ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const TIMEOUT_MS = 5000;
const RETRIES = 1; // 再試行: タイムアウト・ネットワーク断・5xx・429・JSON破損

// fresh : この秒数までは上流に触れず即返す
// stale : この秒数までは古い値を即返し、裏で更新する
const TTL = {
  search:   { fresh: 600,  stale: 3600 },
  shorts:   { fresh: 300,  stale: 3600 },
  video:    { fresh: 900,  stale: 3600 },
  channel:  { fresh: 1800, stale: 7200 },
  comments: { fresh: 900,  stale: 3600 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== レスポンス共通 =====
function jsonRes(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function cacheable(data, stale) {
  return jsonRes(data, 200, {
    "Cache-Control": `public, max-age=${stale}`,
    "X-Stored-At": String(Date.now()),
  });
}

function withState(res, state, maxAge) {
  const h = new Headers(res.headers);
  h.set("X-Cache", state);
  h.set("Cache-Control", `public, max-age=${Math.max(0, Math.floor(maxAge))}`);
  return new Response(res.body, { status: res.status, headers: h });
}

// ===== 同時リクエストの合流 =====
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ===== isolate 内メモ (失敗・空の値は保存しない) =====
const memo = new Map();
function memoize(key, ttlSec, compute) {
  const hit = memo.get(key);
  if (hit) {
    if (hit.pending) return hit.pending;
    if (hit.exp > Date.now()) return Promise.resolve(hit.value);
  }
  if (memo.size > 300) memo.clear();
  const pending = compute().then(
    (value) => {
      memo.set(key, { value, exp: Date.now() + ttlSec * 1000 });
      return value;
    },
    (err) => {
      memo.delete(key);
      throw err;
    },
  );
  memo.set(key, { pending });
  return pending;
}

// ===== エッジキャッシュ (stale-while-revalidate, 不完全な結果は保存しない) =====
async function respond(request, ctx, kind, compute, isValid) {
  const cache = caches.default;
  const key = new Request(request.url, { method: "GET" });
  const { fresh, stale } = TTL[kind];
  const hit = await cache.match(key);

  if (hit) {
    const age = (Date.now() - Number(hit.headers.get("X-Stored-At") || 0)) / 1000;
    if (age < fresh) return withState(hit, "HIT", fresh - age);
    ctx.waitUntil(
      dedupe("rev:" + request.url, () => refresh(cache, key, compute, stale, isValid)).catch(() => {}),
    );
    return withState(hit, "STALE", 0);
  }

  const data = await dedupe("get:" + request.url, compute);
  if (!isValid(data)) {
    // 不完全な結果は返すがキャッシュしない (次回また取り直す)
    return jsonRes(data, 200, { "Cache-Control": "no-store", "X-Cache": "BYPASS" });
  }
  const res = cacheable(data, stale);
  ctx.waitUntil(cache.put(key, res.clone()));
  return withState(res, "MISS", fresh);
}

// 裏更新で不完全な結果が来た場合は、良い古い値を上書きしない
async function refresh(cache, key, compute, stale, isValid) {
  const data = await compute();
  if (isValid(data)) await cache.put(key, cacheable(data, stale));
}

// ===== YouTube 呼び出し (再試行つき) =====
async function yt(endpoint, body, client = WEB) {
  let lastErr = new Error(`YouTube ${endpoint} failed`);
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(250 * attempt);
    try {
      const res = await fetch(`${YT}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": client.ua, ...client.headers },
        body: JSON.stringify({ context: client.context, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`YouTube ${endpoint} failed: ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // 4xx は再試行しない
    } catch (e) {
      lastErr = e; // タイムアウト・ネットワーク断・JSON破損
    }
  }
  throw lastErr;
}

const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? t?.content ?? "";
const isChannelId = (s) => typeof s === "string" && /^UC[\w-]{22}$/.test(s);

// 深いJSONを1回だけ走査して複数キーを同時に収集
function walk(obj, keys, out) {
  if (!obj || typeof obj !== "object") return;
  for (const k in obj) {
    if (keys.has(k)) out[k].push(obj[k]);
    walk(obj[k], keys, out);
  }
}
function collectMany(root, keyList) {
  const out = {};
  for (const k of keyList) out[k] = [];
  walk(root, new Set(keyList), out);
  return out;
}
const collect = (obj, key) => collectMany(obj, [key])[key];

// 種別ごとの重複除去 (ページ境界・ネスト由来の重複を防ぐ)
function dedupeItems(items) {
  const seen = new Set();
  return items.filter((r) => {
    const id = r.videoId || r.channelId || r.playlistId;
    if (!id) return false;
    const k = r.type + id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ===== lockup 判定 =====
const isPlaylistLockup = (l) => l.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST";
const isVideoLockup = (l) => !l.contentType || l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO";

// ===== マッパー =====
function mapVideo(v) {
  return {
    type: "video",
    videoId: v.videoId,
    title: text(v.title),
    author: text(v.ownerText || v.shortBylineText),
    authorId: (v.ownerText || v.shortBylineText)?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
    lengthText: text(v.lengthText),
    viewCountText: text(v.viewCountText),
    publishedText: text(v.publishedTimeText),
    thumbnails: v.thumbnail?.thumbnails ?? [],
  };
}

function mapLockupVideo(v) {
  const meta = v.metadata?.lockupMetadataViewModel ?? {};
  const rows = meta.metadata?.contentMetadataViewModel?.metadataRows ?? [];
  const parts = rows.flatMap((r) => r.metadataParts ?? []).map((p) => p.text?.content).filter(Boolean);
  const thumb = v.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel
    ?? v.contentImage?.thumbnailViewModel ?? {};
  return {
    type: "video",
    videoId: v.contentId ?? v.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId,
    title: meta.title?.content,
    author: meta.image?.decoratedAvatarViewModel?.a11yLabel?.replace(/^チャンネル「|」に移動します$/g, "") || parts[0],
    authorId: meta.image?.decoratedAvatarViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId,
    lengthText: collect(v, "thumbnailBadgeViewModel").map((b) => b.text).find((t) => /^\d+:\d+/.test(t || "")),
    viewCountText: parts.find((p) => /回視聴|views/i.test(p)),
    publishedText: parts.find((p) => /前$/.test(p)),
    thumbnails: thumb.image?.sources ?? [],
  };
}

function mapShort(s) {
  return {
    type: "short",
    videoId: s.videoId,
    title: text(s.headline),
    viewCountText: text(s.viewCountText),
    thumbnails: s.thumbnail?.thumbnails ?? [],
    url: `https://www.youtube.com/shorts/${s.videoId}`,
  };
}

function mapShortLockup(s) {
  const reel = s.onTap?.innertubeCommand?.reelWatchEndpoint ?? {};
  const videoId = reel.videoId ?? s.entityId?.replace("shorts-shelf-item-", "");
  return {
    type: "short",
    videoId,
    title: s.overlayMetadata?.primaryText?.content ?? s.accessibilityText,
    viewCountText: s.overlayMetadata?.secondaryText?.content,
    thumbnails: reel.thumbnail?.thumbnails ?? [],
    url: `https://www.youtube.com/shorts/${videoId}`,
  };
}

function mapChannel(c) {
  // 新レイアウトでは subscriberCountText に @handle、videoCountText に登録者数が入る
  const a = text(c.subscriberCountText), b = text(c.videoCountText);
  const handle = [a, b].find((t) => t.startsWith("@"));
  const subs = [b, a].find((t) => t && !t.startsWith("@"));
  return {
    type: "channel",
    channelId: c.channelId,
    title: text(c.title),
    handle,
    subscriberText: subs,
    description: text(c.descriptionSnippet),
    verified: collect(c, "metadataBadgeRenderer").length > 0,
    thumbnails: (c.thumbnail?.thumbnails ?? []).map((t) => ({
      ...t,
      url: t.url?.startsWith("//") ? "https:" + t.url : t.url,
    })),
  };
}

function mapPlaylist(p) {
  return {
    type: "playlist",
    playlistId: p.playlistId,
    title: text(p.title),
    videoCount: text(p.videoCountText || p.videoCountShortText),
    thumbnails: p.thumbnail?.thumbnails ?? p.thumbnails?.[0]?.thumbnails ?? [],
  };
}

function mapLockupPlaylist(v) {
  const meta = v.metadata?.lockupMetadataViewModel ?? {};
  const thumb = v.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel ?? {};
  return {
    type: "playlist",
    playlistId: v.contentId,
    title: meta.title?.content,
    videoCount: collect(thumb, "thumbnailBadgeViewModel").map((b) => b.text).find(Boolean),
    thumbnails: thumb.image?.sources ?? [],
  };
}

// ===== パーサー =====
const SEARCH_KEYS = ["lockupViewModel", "playlistRenderer", "channelRenderer", "reelItemRenderer", "shortsLockupViewModel", "videoRenderer"];

function parseSearchResults(data) {
  const c = collectMany(data, SEARCH_KEYS);
  return [
    ...c.lockupViewModel.filter(isPlaylistLockup).map(mapLockupPlaylist),
    ...c.lockupViewModel.filter(isVideoLockup).map(mapLockupVideo), // 新形式の動画 (従来は取りこぼしていた)
    ...c.playlistRenderer.map(mapPlaylist),
    ...c.channelRenderer.map(mapChannel),
    ...c.reelItemRenderer.map(mapShort),
    ...c.shortsLockupViewModel.map(mapShortLockup),
    ...c.videoRenderer.map(mapVideo),
  ];
}

function parseShorts(data) {
  const c = collectMany(data, ["reelItemRenderer", "shortsLockupViewModel"]);
  return [...c.reelItemRenderer.map(mapShort), ...c.shortsLockupViewModel.map(mapShortLockup)];
}

function nextToken(data) {
  return collect(data, "continuationCommand").map((c) => c.token).find(Boolean);
}

// 1ページ目 + 追加ページ (more 回まで)
async function paginate(endpoint, body, parse, more = 0, getToken = nextToken) {
  let data = await yt(endpoint, body);
  const items = parse(data);
  let token = getToken(data);
  let page = 0;
  while (page < more && token) {
    data = await yt(endpoint, { continuation: token });
    items.push(...parse(data));
    token = getToken(data);
    page++;
  }
  return { items: dedupeItems(items), page, hasMore: !!token };
}

// ===== 検索 =====
const SEARCH_FILTER = { channel: "EgIQAg%3D%3D", video: "EgIQAQ%3D%3D", playlist: "EgIQAw%3D%3D" };

async function search(q, more = 0, type) {
  const params = SEARCH_FILTER[type] ? decodeURIComponent(SEARCH_FILTER[type]) : undefined;
  const { items, page, hasMore } = await paginate(
    "search",
    { query: q, ...(params && { params }) },
    parseSearchResults,
    more,
  );
  return {
    query: q,
    type: type || "all",
    page,
    hasMore,
    channels: items.filter((r) => r.type === "channel"),
    results: items,
  };
}

// ===== 動画 =====
// WEB で配信情報が欠ける動画は ANDROID クライアントで再取得
async function fetchPlayer(videoId) {
  const player = await yt("player", { videoId });
  if (player.streamingData) return player;
  try {
    const alt = await yt("player", { videoId }, ANDROID);
    if (alt.streamingData) {
      return { ...alt, videoDetails: alt.videoDetails ?? player.videoDetails };
    }
  } catch {
    // 代替取得に失敗したら WEB の結果をそのまま使う
  }
  return player;
}

const validVideo = (d) =>
  !!d.title &&
  !d.partial &&
  (d.formats.length + d.adaptiveFormats.length > 0 || !!d.hlsUrl || d.playability !== "OK");

async function video(videoId, withRelated = true) {
  const nextP = withRelated
    ? yt("next", { videoId }).catch(() => null)
    : Promise.resolve(undefined);
  const [player, next] = await Promise.all([fetchPlayer(videoId), nextP]);
  const d = player.videoDetails ?? {};

  let related = [];
  if (next) {
    const c = collectMany(next, ["compactVideoRenderer", "lockupViewModel"]);
    related = dedupeItems([
      ...c.compactVideoRenderer.map(mapVideo),
      ...c.lockupViewModel.filter(isVideoLockup).map(mapLockupVideo),
    ]).filter((v) => v.videoId !== videoId);
  }

  const result = {
    videoId,
    title: d.title,
    description: d.shortDescription,
    author: d.author,
    authorId: d.channelId,
    lengthSeconds: Number(d.lengthSeconds || 0),
    viewCount: Number(d.viewCount || 0),
    keywords: d.keywords ?? [],
    isLive: !!d.isLiveContent,
    thumbnails: d.thumbnail?.thumbnails ?? [],
    playability: player.playabilityStatus?.status,
    reason: player.playabilityStatus?.reason,
    formats: player.streamingData?.formats ?? [],
    adaptiveFormats: player.streamingData?.adaptiveFormats ?? [],
    hlsUrl: player.streamingData?.hlsManifestUrl,
    related,
  };
  // 関連動画の取得に失敗した場合は partial を付ける (この結果はキャッシュしない)
  if (withRelated && !next) result.partial = true;
  return result;
}

// ===== Shorts =====
// トレンドフィードは isolate 内で5分間共有。空や失敗はメモしない
function fetchShortsFeed() {
  return memoize("feed:shorts", 300, async () => {
    const d = await yt("search", { query: "#shorts" });
    const items = dedupeItems(parseShorts(d));
    if (!items.length) throw new Error("empty shorts feed");
    return { items, token: nextToken(d) };
  });
}

async function trendingShorts(more) {
  const feed = await fetchShortsFeed();
  const items = [...feed.items];
  let token = feed.token;
  let page = 0;
  while (page < more && token) {
    const d = await yt("search", { continuation: token });
    items.push(...parseShorts(d));
    token = nextToken(d);
    page++;
  }
  return { type: "trending", page, hasMore: !!token, shorts: dedupeItems(items) };
}

async function shortDetail(videoId, withRelated) {
  const [v, feed] = await Promise.all([
    video(videoId, withRelated),
    fetchShortsFeed().catch(() => ({ items: [] })),
  ]);
  const list = feed.items.filter((s) => s.videoId);
  const idx = list.findIndex((s) => s.videoId === videoId);
  const next = (idx >= 0 ? list.slice(idx + 1) : list)
    .filter((s) => s.videoId !== videoId)
    .slice(0, 3);
  return { ...v, type: "short", url: `https://www.youtube.com/shorts/${videoId}`, next };
}

// ===== チャンネル =====
const TAB_PARAMS = {
  videos: "EgZ2aWRlb3PyBgQKAjoA",
  shorts: "EgZzaG9ydHPyBgUKA5oBAA==",
  live: "EgdzdHJlYW1z8gYECgJ6AA==",
  playlists: "EglwbGF5bGlzdHPyBgQKAkIA",
};
const TAB_PATH = { videos: "/videos", shorts: "/shorts", live: "/streams", playlists: "/playlists" };
const TAB_KINDS = ["videos", "shorts", "live", "playlists"];

// @handle / URL → channelId。成功時のみ1日メモ化
function resolveChannelId(id) {
  if (isChannelId(id)) return Promise.resolve(id);
  return memoize(`handle:${id}`, 86400, async () => {
    const path = id.startsWith("@") ? id : id.startsWith("http") ? null : `@${id}`;
    const url = path ? `https://www.youtube.com/${path}` : id;
    const r = await yt("navigation/resolve_url", { url });
    const browseId = r.endpoint?.browseEndpoint?.browseId ?? collect(r, "browseId").find(isChannelId);
    if (!browseId) throw new Error("channel not found");
    return browseId;
  });
}

// ページ内のタブ定義から params を発見する (固定値が変わった時の保険)
function discoverTabParams(base) {
  const found = {};
  for (const t of collect(base, "tabRenderer")) {
    const url = t.endpoint?.commandMetadata?.webCommandMetadata?.url ?? "";
    const params = t.endpoint?.browseEndpoint?.params;
    if (!params) continue;
    for (const kind of TAB_KINDS) {
      if (url.endsWith(TAB_PATH[kind])) found[kind] = params;
    }
  }
  return found;
}

function channelMeta(data, channelId) {
  const meta = data.metadata?.channelMetadataRenderer ?? {};
  const header = data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};
  const c4 = data.header?.c4TabbedHeaderRenderer ?? {};
  const rows = header.metadata?.contentMetadataViewModel?.metadataRows ?? [];
  const parts = rows.flatMap((r) => r.metadataParts ?? []).map((p) => p.text?.content).filter(Boolean);
  const micro = data.microformat?.microformatDataRenderer ?? {};
  return {
    channelId: meta.externalId ?? channelId,
    title: meta.title ?? header.title?.content ?? text(c4.title),
    handle: parts.find((p) => p.startsWith("@")) ?? text(c4.channelHandleText),
    description: meta.description,
    subscriberText: parts.find((p) => /登録者|subscriber/i.test(p)) ?? text(c4.subscriberCountText),
    videoCountText: parts.find((p) => /本の動画|videos?$/i.test(p)) ?? text(c4.videosCountText),
    avatar: meta.avatar?.thumbnails ?? [],
    banner: header.banner?.imageBannerViewModel?.image?.sources ?? c4.banner?.thumbnails ?? [],
    vanityUrl: meta.vanityChannelUrl,
    channelUrl: meta.channelUrl,
    rssUrl: meta.rssUrl,
    keywords: meta.keywords,
    tags: micro.tags ?? [],
    isFamilySafe: meta.isFamilySafe,
    verified: collect(data.header ?? {}, "metadataBadgeRenderer").length > 0
      || JSON.stringify(data.header ?? {}).includes("CHECK_CIRCLE"),
  };
}

function selectedTab(data) {
  return collect(data, "tabRenderer").find((t) => t.selected) ?? data;
}

const TAB_KEYS = ["lockupViewModel", "videoRenderer", "gridVideoRenderer", "gridPlaylistRenderer"];

function parseTab(data, kind) {
  const root = data.onResponseReceivedActions ? data : selectedTab(data);
  if (kind === "shorts") return parseShorts(root);
  const c = collectMany(root, TAB_KEYS);
  if (kind === "playlists") {
    return [
      ...c.gridPlaylistRenderer.map(mapPlaylist),
      ...c.lockupViewModel.filter(isPlaylistLockup).map(mapLockupPlaylist),
    ];
  }
  const lock = c.lockupViewModel
    .filter((l) => !isPlaylistLockup(l))
    .map((l) => {
      const m = mapLockupVideo(l);
      if (kind === "live") {
        const badges = collect(l, "thumbnailBadgeViewModel").map((b) => `${b.text} ${b.badgeStyle}`).join(" ");
        m.type = "live";
        m.isLiveNow = /LIVE|ライブ/i.test(badges);
        m.isUpcoming = /UPCOMING|予定/i.test(badges);
      }
      return m;
    });
  const vids = [...c.videoRenderer, ...c.gridVideoRenderer].map((v) => {
    const m = mapVideo(v);
    if (kind === "live") {
      const badges = collect(v, "metadataBadgeRenderer").map((b) => b.style);
      m.type = "live";
      m.isLiveNow = badges.includes("BADGE_STYLE_TYPE_LIVE_NOW")
        || !!v.thumbnailOverlays?.some((o) => o.thumbnailOverlayTimeStatusRenderer?.style === "LIVE");
      m.isUpcoming = !!v.upcomingEventData;
      m.startTime = v.upcomingEventData?.startTime ? Number(v.upcomingEventData.startTime) : undefined;
    }
    return m;
  });
  return [...lock, ...vids];
}

async function channelTab(channelId, kind, more, params = TAB_PARAMS[kind]) {
  try {
    return await paginate(
      "browse",
      { browseId: channelId, params },
      (d) => parseTab(d, kind),
      more,
      (d) => nextToken(selectedTab(d)), // 選択中タブの continuation のみ使う
    );
  } catch (e) {
    return { items: [], hasMore: false, error: String(e?.message || e) };
  }
}

async function channel(rawId, kinds, more = 0) {
  const channelId = await resolveChannelId(rawId);
  const [base, ...tabs] = await Promise.all([
    yt("browse", { browseId: channelId }),
    ...kinds.map((k) => channelTab(channelId, k, more)),
  ]);

  // 固定 params で失敗、または空だった場合だけ、ページから発見した params で1回再取得
  const discovered = discoverTabParams(base);
  const fixed = await Promise.all(kinds.map(async (k, i) => {
    const alt = discovered[k];
    const t = tabs[i];
    if (alt && alt !== TAB_PARAMS[k] && (t.error || !t.items.length)) {
      return channelTab(channelId, k, more, alt);
    }
    return t;
  }));

  const result = channelMeta(base, channelId);
  const errors = [];
  kinds.forEach((k, i) => {
    const t = fixed[i];
    result[k] = t.items;
    result[`${k}HasMore`] = t.hasMore;
    if (t.error) errors.push(`${k}: ${t.error}`);
  });
  if (errors.length) result.errors = errors;
  return result;
}

// ===== コメント =====
// コメント continuation token は成功時のみ1時間メモ化
function commentsToken(videoId) {
  return memoize(`ctok:${videoId}`, 3600, async () => {
    const next = await yt("next", { videoId });
    const token = nextToken(next);
    if (!token) throw new Error("no comments token");
    return token;
  });
}

async function comments(videoId) {
  const token = await commentsToken(videoId).catch(() => null);
  if (!token) return { videoId, comments: [] };
  const data = await yt("next", { continuation: token });

  const c = collectMany(data, ["commentEntityPayload", "commentRenderer"]);
  let list = c.commentEntityPayload.map((p) => ({
    commentId: p.properties?.commentId,
    author: p.author?.displayName,
    authorId: p.author?.channelId,
    authorThumbnail: p.author?.avatarThumbnailUrl,
    content: p.properties?.content?.content,
    publishedText: p.properties?.publishedTime,
    likeCount: p.toolbar?.likeCountNotliked,
    replyCount: p.toolbar?.replyCount,
  }));
  if (!list.length) {
    list = c.commentRenderer.map((r) => ({
      commentId: r.commentId,
      author: text(r.authorText),
      authorId: r.authorEndpoint?.browseEndpoint?.browseId,
      authorThumbnail: r.authorThumbnail?.thumbnails?.[0]?.url,
      content: text(r.contentText),
      publishedText: text(r.publishedTimeText),
      likeCount: text(r.voteCount),
    }));
  }
  // 空だった場合は token のメモを捨てて、次回は取り直す
  if (!list.length) memo.delete(`ctok:${videoId}`);
  return { videoId, comments: dedupeItems(list.map((x) => ({ ...x, type: "comment", videoId: x.commentId })))
    .map(({ type, videoId: _v, ...rest }) => rest) };
}

// ===== 有効性チェック (不完全な結果をキャッシュしないため) =====
const valid = {
  search: (d) => d.results.length > 0,
  trending: (d) => d.shorts.length > 0,
  video: validVideo,
  channel: (d) => !!d.title && !d.errors,
  comments: (d) => d.comments.length > 0,
};

// ===== ルーター =====
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return jsonRes({ error: "Method Not Allowed" }, 405);

    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "v1") {
      return jsonRes({
        message: "Hello The World API",
        endpoints: [
          "/api/v1/search?q={keyword}(&type=channel|video|playlist)",
          "/api/v1/shorts/{videoId}(&light=1)",
          "/api/v1/videos/{videoId}(&light=1)",
          "/api/v1/channels/{channelId|@handle}(&videos&shorts&live&playlists)",
          "/api/v1/comments/{videoId}",
        ],
      });
    }

    const [, , resource, id] = parts;
    const more = Math.max(0, parseInt(url.searchParams.get("more") || "0", 10) || 0);
    const light = url.searchParams.get("light") === "1";

    try {
      switch (resource) {
        case "search": {
          const q = url.searchParams.get("q");
          if (!q) return jsonRes({ error: "q is required" }, 400);
          return await respond(request, ctx, "search",
            () => search(q, more, url.searchParams.get("type")),
            valid.search);
        }
        case "shorts":
          return await respond(request, ctx, "shorts",
            () => (id ? shortDetail(id, !light) : trendingShorts(id ? 0 : more)),
            id ? valid.video : valid.trending);
        case "videos":
          if (!id) return jsonRes({ error: "videoId is required" }, 400);
          return await respond(request, ctx, "video",
            () => video(id, !light), valid.video);
        case "channels": {
          if (!id) return jsonRes({ error: "channelId is required" }, 400);
          const [cid, ...flags] = decodeURIComponent(id).split("&");
          const alias = { playlist: "playlists", streams: "live", stream: "live", video: "videos", short: "shorts" };
          const req = [...flags, ...url.searchParams.keys()]
            .map((f) => alias[f.split("=")[0]] ?? f.split("=")[0]);
          let kinds = TAB_KINDS.filter((k) => req.includes(k));
          if (!kinds.length) kinds = TAB_KINDS;
          return await respond(request, ctx, "channel",
            () => channel(cid, kinds, more), valid.channel);
        }
        case "comments":
          if (!id) return jsonRes({ error: "videoId is required" }, 400);
          return await respond(request, ctx, "comments",
            () => comments(id), valid.comments);
        default:
          return jsonRes({ error: "Not Found" }, 404);
      }
    } catch (e) {
      return jsonRes({ error: String(e?.message || e) }, 502);
    }
  },
};