// Run: node server.js   (Node 18+, no npm install needed)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const USER_RE = /^[A-Za-z0-9._]{1,24}$/;
const hits = new Map(); // ip -> [timestamps]
const cache = new Map(); // username -> {t, r}

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

const iso = (s) => (s > 0 ? new Date(s * 1000).toISOString() : null);
const date = (s) => ({ epochSeconds: s || 0, iso: iso(s) });

async function lookup(username) {
  const res = await fetch("https://www.tiktok.com/@" + username, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.8",
    },
  });
  if (!res.ok) return { status: res.status === 404 ? 404 : 502, error: "TikTok returned HTTP " + res.status };

  const html = await res.text();
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { status: 502, error: "Embedded JSON not found. TikTok may have blocked the request or changed its page." };

  let payload;
  try { payload = JSON.parse(m[1]); } catch { return { status: 502, error: "Could not parse TikTok JSON." }; }

  const detail = payload.__DEFAULT_SCOPE__ && payload.__DEFAULT_SCOPE__["webapp.user-detail"];
  const info = detail && detail.userInfo;
  if (!info || !info.user) return { status: 404, error: "User not found or profile unavailable." };

  const u = info.user, s = info.stats || {};
  return {
    status: 200,
    data: {
      profile: {
        id: u.id, secUid: u.secUid, username: u.uniqueId, nickname: u.nickname,
        bio: u.signature, language: u.language, verified: !!u.verified,
        privateAccount: !!u.privateAccount, avatar: u.avatarLarger,
        avatars: { large: u.avatarLarger, medium: u.avatarMedium, thumb: u.avatarThumb },
        region: u.region || null,
        bioLink: (u.bioLink && u.bioLink.link) || null,
        organization: !!u.isOrganization,
        commerceUser: !!(u.commerceUserInfo && u.commerceUserInfo.commerceUser),
        seller: !!u.ttSeller,
        openFavorite: !!u.openFavorite,
        live: !!(u.roomId && u.roomId !== "0"),
      },
      dates: {
        created: date(u.createTime),
        nicknameModified: date(u.nickNameModifyTime),
        usernameModified: date(u.uniqueIdModifyTime),
      },
      stats: {
        followers: s.followerCount, following: s.followingCount,
        likes: s.heartCount != null ? s.heartCount : s.heart,
        videos: s.videoCount, friends: s.friendCount, likesGiven: s.diggCount,
      },
      settings: {
        comments: u.commentSetting, duet: u.duetSetting, stitch: u.stitchSetting,
        download: u.downloadSetting, followingVisibility: u.followingVisibility,
        embed: u.profileEmbedPermission,
      },
      profileTab: info.profileTab || {},
    },
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  if (url.pathname === "/api/profile") {
    if (limited(req.socket.remoteAddress)) return send(429, { error: "Rate limit: slow down." });
    const username = (url.searchParams.get("username") || "").replace(/^@/, "");
    if (!USER_RE.test(username)) return send(400, { error: "Invalid username. Use letters, numbers, . and _ only." });
    try {
      const key = username.toLowerCase();
      const c = cache.get(key);
      let r = c && Date.now() - c.t < 300000 ? c.r : null;
      if (!r) { r = await lookup(username); if (r.status === 200) cache.set(key, { t: Date.now(), r }); }
      return send(r.status, r.data || { error: r.error });
    } catch (e) {
      return send(502, { error: "Request to TikTok failed." });
    }
  }

  if (url.pathname === "/healthz") return send(200, { ok: true });
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html; charset=utf-8");
  }
  send(404, { error: "Not found" });
}).listen(PORT, () => console.log("[+] listening on http://localhost:" + PORT));
