/* RabbitEars TV — Web Player
 *
 * A self-contained, "access anywhere" multi-stream player. Channels are plain
 * stream URLs (HLS / MP4 / WebM / YouTube) played directly in the browser, so
 * no transcoding backend is required. The retro TV remote (seven-seg display,
 * channel up/down, keypad) drives which stream is on screen.
 *
 * A channel can also be a "loop" channel: point it at a folder (directory
 * autoindex), an .m3u / .json playlist, or an inline list of files, and it
 * plays through them in order (or shuffled), auto-advancing and looping.
 */

(() => {
  "use strict";

  const STORE_KEY = "rabbitears_channels";
  const LAST_KEY = "rabbitears_last_channel";

  // Files the browser can actually play (mkv/avi need transcoding first).
  const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov|m3u8)$/i;

  // Embedded fallback so the app still works when opened from file:// (where
  // fetching channels.json may be blocked).
  const FALLBACK = [
    { channel_number: 2, network_name: "Big Buck Bunny", type: "hls",
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", title: "Open movie · HLS demo" },
    { channel_number: 4, network_name: "Tears of Steel", type: "hls",
      url: "https://test-streams.mux.dev/tos_ismc/main.m3u8", title: "Blender short film" },
    { channel_number: 9, network_name: "Lofi", type: "youtube",
      url: "https://www.youtube.com/watch?v=jfKfPfyJRdk", title: "lofi hip hop radio · live" },
  ];

  // ---- DOM (cached lazily in cacheDom() so this file is also Node-requirable
  // for unit-testing the pure parser) ----
  const el = (id) => document.getElementById(id);
  let screen, video, yt, staticCanvas, osd, osdChan, osdName,
      sevenSeg, networkName, titleEl, entryEl, unmuteHint;

  function cacheDom() {
    screen = el("screen");
    video = el("video");
    yt = el("yt");
    staticCanvas = el("static");
    osd = el("osd");
    osdChan = el("osd-chan");
    osdName = el("osd-name");
    sevenSeg = el("current-channel");
    networkName = el("network-name");
    titleEl = el("title");
    entryEl = el("entry");
    unmuteHint = el("unmute-hint");
  }

  // ---- State ----
  let channels = [];
  let currentIndex = -1;
  let hls = null;
  let entryBuffer = "";
  let entryTimer = null;
  let osdTimer = null;
  let staticRAF = null;
  let staticStop = 0;
  // Loop-channel state
  let tuneToken = 0;     // bumped on every tune so stale async resolves are ignored
  let playlist = null;   // array of media URLs when on a loop channel, else null
  let playlistPos = 0;
  let baseTitle = "";    // channel title shown alongside the current item name

  // ===================================================================
  // Channel data (load / persist)
  // ===================================================================
  function normalize(list) {
    return (list || [])
      .map((c, i) => {
        const url = (c.url || "").trim();
        const inlinePlaylist = Array.isArray(c.playlist) ? c.playlist.filter(Boolean) : null;
        let type = c.type;
        if (!type) type = inlinePlaylist ? "playlist" : detectType(url);
        return {
          channel_number: Number(c.channel_number ?? c.channel ?? i + 1),
          network_name: c.network_name || c.name || `Channel ${i + 1}`,
          url,
          type,
          title: c.title || "",
          playlist: inlinePlaylist,
          order: c.order === "shuffle" ? "shuffle" : "sequential",
        };
      })
      .filter((c) => c.url || (c.playlist && c.playlist.length))
      .sort((a, b) => a.channel_number - b.channel_number);
  }

  function detectType(url) {
    const u = url.toLowerCase().split("?")[0];
    if (/youtube\.com|youtu\.be/.test(u)) return "youtube";
    if (u.endsWith("/")) return "folder";       // directory autoindex
    if (u.endsWith(".m3u")) return "folder";     // playlist file (.m3u8 is HLS, handled below)
    if (u.endsWith(".m3u8")) return "hls";
    return "mp4";
  }

  function isLoopType(type) {
    return type === "folder" || type === "playlist";
  }

  async function loadChannels() {
    // 1) user-customized list wins
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return normalize(saved);
    } catch (_) { /* ignore */ }

    // 2) bundled channels.json
    try {
      const resp = await fetch("channels.json", { cache: "no-store" });
      if (resp.ok) {
        const data = await resp.json();
        const list = Array.isArray(data) ? data : data.channels;
        if (list && list.length) return normalize(list);
      }
    } catch (_) { /* fall through to embedded defaults */ }

    // 3) embedded fallback
    return normalize(FALLBACK);
  }

  function saveChannels(list) {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  }

  // ===================================================================
  // Loop channel: resolve a folder / playlist into a list of media URLs
  // ===================================================================

  // Pure parser: turn a folder listing / playlist body into media URLs.
  // Handles JSON arrays, .m3u playlists, and HTML directory autoindexes.
  function parseListing(text, baseUrl) {
    const out = [];
    const body = (text || "").trim();
    const absolutize = (href) => {
      try { return new URL(href, baseUrl).href; } catch (_) { return null; }
    };

    if (body.startsWith("[") || body.startsWith("{")) {
      // JSON: array of strings, or array of objects with .url, or { files: [...] }
      try {
        let data = JSON.parse(body);
        if (!Array.isArray(data)) data = data.files || data.items || data.playlist || [];
        for (const item of data) {
          const href = typeof item === "string" ? item : (item && item.url);
          if (href) out.push(absolutize(href));
        }
      } catch (_) { /* not valid JSON, fall through */ }
    } else if (/^#EXTM3U/m.test(body) || (!/[<>]/.test(body) && /\n/.test(body))) {
      // .m3u playlist (or a plain newline-separated URL list)
      for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        out.push(absolutize(line));
      }
    } else {
      // HTML directory listing: pull href targets
      const re = /href\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(body)) !== null) out.push(absolutize(m[1]));
    }

    return out
      .filter((u) => u && VIDEO_EXT.test(u.split("?")[0]))
      .filter((u, i, a) => a.indexOf(u) === i); // de-dupe
  }

  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function resolveItems(ch) {
    let items;
    if (ch.playlist && ch.playlist.length) {
      const base = new URL(location.href);
      items = ch.playlist
        .map((u) => { try { return new URL(u, base).href; } catch (_) { return null; } })
        .filter(Boolean);
    } else {
      const resp = await fetch(ch.url, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      items = parseListing(await resp.text(), resp.url || ch.url);
    }
    if (ch.order === "shuffle") shuffleInPlace(items);
    else items.sort(naturalSort);
    return items;
  }

  // ===================================================================
  // YouTube helpers
  // ===================================================================
  function youtubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ===================================================================
  // Playback
  // ===================================================================
  function teardownVideo() {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute("src");
    video.load();
  }

  function showNoSignal(on) {
    screen.classList.toggle("no-signal-on", on);
  }

  // Play a single media URL (HLS via hls.js where needed, else native).
  function playMedia(url, type) {
    type = type || detectType(url);
    screen.classList.remove("is-youtube");
    showNoSignal(false);
    teardownVideo();

    if (type === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => safePlay());
        hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) showNoSignal(true);
        });
        return;
      }
      showNoSignal(true);
      return;
    }

    // Native HLS (Safari/iOS) or progressive MP4/WebM
    video.src = url;
    video.addEventListener("error", () => showNoSignal(true), { once: true });
    safePlay();
  }

  function itemName(url) {
    try {
      const path = new URL(url, location.href).pathname;
      return decodeURIComponent(path.split("/").pop() || "");
    } catch (_) { return ""; }
  }

  function setTitle(text) {
    titleEl.textContent = text || "";
  }

  async function playChannel(index, { withStatic = true } = {}) {
    if (index < 0 || index >= channels.length) return;
    currentIndex = index;
    const ch = channels[index];
    const token = ++tuneToken;
    playlist = null;

    localStorage.setItem(LAST_KEY, String(ch.channel_number));
    updateRemote(ch);
    flashOSD(ch);
    if (withStatic) runStatic();

    showNoSignal(false);
    teardownVideo();
    yt.src = "about:blank";

    if (ch.type === "youtube") {
      const id = youtubeId(ch.url);
      screen.classList.add("is-youtube");
      if (id) {
        yt.src = `https://www.youtube.com/embed/${id}?autoplay=1&mute=${video.muted ? 1 : 0}&playsinline=1&rel=0`;
      } else {
        showNoSignal(true);
      }
      return;
    }

    if (isLoopType(ch.type) || ch.playlist) {
      baseTitle = ch.title || "";
      try {
        const items = await resolveItems(ch);
        if (token !== tuneToken) return;          // user changed channel meanwhile
        if (!items.length) { showNoSignal(true); setTitle("No playable files"); return; }
        playlist = items;
        playlistPos = 0;
        playPlaylistItem();
      } catch (_) {
        if (token !== tuneToken) return;
        showNoSignal(true);
        setTitle("Folder unreachable");
      }
      return;
    }

    // Single stream / file
    baseTitle = "";
    setTitle(ch.title || "");
    playMedia(ch.url, ch.type);
  }

  function playPlaylistItem() {
    if (!playlist || !playlist.length) return;
    const url = playlist[playlistPos];
    const name = itemName(url);
    setTitle(baseTitle ? `${baseTitle} — ${name}` : name);
    playMedia(url, detectType(url));
  }

  function onMediaEnded() {
    if (!playlist || !playlist.length) return;   // single VOD just stops
    playlistPos = (playlistPos + 1) % playlist.length;
    runStatic(250);
    playPlaylistItem();
  }

  function safePlay() {
    const p = video.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay blocked unless muted — mute, retry, show unmute hint
        video.muted = true;
        syncMuteButton();
        unmuteHint.hidden = false;
        video.play().catch(() => {});
      });
    }
  }

  // ===================================================================
  // Tuning
  // ===================================================================
  function tuneByOffset(delta) {
    if (!channels.length) return;
    let i = currentIndex;
    i = (i + delta + channels.length) % channels.length;
    playChannel(i);
  }

  function tuneByNumber(num) {
    const i = channels.findIndex((c) => c.channel_number === num);
    if (i >= 0) {
      playChannel(i);
    } else {
      // tuned to an empty channel
      currentIndex = -1;
      tuneToken++;
      playlist = null;
      sevenSeg.textContent = String(num).padStart(2, "0");
      networkName.textContent = "";
      setTitle("");
      teardownVideo();
      yt.src = "about:blank";
      screen.classList.remove("is-youtube");
      runStatic();
      showNoSignal(true);
    }
  }

  // ===================================================================
  // Remote UI
  // ===================================================================
  function updateRemote(ch) {
    sevenSeg.textContent = String(ch.channel_number).padStart(2, "0");
    networkName.textContent = ch.network_name || "";
    setTitle(ch.title || "");
  }

  function flashOSD(ch) {
    osdChan.textContent = String(ch.channel_number).padStart(2, "0");
    osdName.textContent = ch.network_name || "";
    osd.classList.add("show");
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.remove("show"), 3000);
  }

  function appendDigit(n) {
    if (entryBuffer.length >= 2) entryBuffer = "";
    entryBuffer += String(n);
    entryEl.textContent = entryBuffer;
    clearTimeout(entryTimer);
    entryTimer = setTimeout(() => commitEntry(false), 1500);
  }

  function clearEntry() {
    entryBuffer = "";
    entryEl.textContent = "_";
    clearTimeout(entryTimer);
  }

  function commitEntry(force) {
    const num = parseInt(entryBuffer, 10);
    if (!isNaN(num)) tuneByNumber(num);
    if (force || entryBuffer.length > 0) clearEntry();
  }

  // ===================================================================
  // TV static effect
  // ===================================================================
  function runStatic(ms = 450) {
    const c = staticCanvas;
    const ctx = c.getContext("2d");
    c.width = 320; c.height = 180;
    screen.classList.add("tuning");
    staticStop = performance.now() + ms;

    const draw = () => {
      const img = ctx.createImageData(c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      if (performance.now() < staticStop) {
        staticRAF = requestAnimationFrame(draw);
      } else {
        screen.classList.remove("tuning");
        cancelAnimationFrame(staticRAF);
      }
    };
    cancelAnimationFrame(staticRAF);
    draw();
  }

  // ===================================================================
  // Audio / fullscreen controls
  // ===================================================================
  function syncMuteButton() {
    el("btn-mute").textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  }

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    unmuteHint.hidden = !video.muted;
    syncMuteButton();
    el("volume").value = video.muted ? 0 : video.volume;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (screen.requestFullscreen) {
      screen.requestFullscreen();
    }
  }

  // ===================================================================
  // Channel editor modal
  // ===================================================================
  function openEditor() {
    const wrap = el("chan-editor");
    wrap.innerHTML =
      `<div class="chan-head"><span>Ch #</span><span>Name</span><span>Stream / folder URL</span><span>Type</span><span></span></div>`;
    channels.forEach((c) => wrap.appendChild(rowFor(c)));
    el("modal").hidden = false;
  }

  function rowFor(c = {}) {
    const row = document.createElement("div");
    row.className = "chan-row";
    row.innerHTML = `
      <input class="f-num" type="number" value="${c.channel_number ?? ""}" placeholder="#">
      <input class="f-name" type="text" value="${escapeAttr(c.network_name || "")}" placeholder="Name">
      <input class="f-url" type="text" value="${escapeAttr(c.url || "")}" placeholder="https://… .m3u8 / .mp4 / youtube / folder/">
      <select class="f-type">
        ${["auto", "hls", "mp4", "youtube", "folder"].map((t) =>
          `<option value="${t}" ${c.type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <button class="del" title="Remove">✕</button>`;
    row.querySelector(".del").addEventListener("click", () => row.remove());
    return row;
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function collectEditor() {
    const rows = [...document.querySelectorAll("#chan-editor .chan-row")];
    const list = rows.map((r) => {
      const url = r.querySelector(".f-url").value.trim();
      let type = r.querySelector(".f-type").value;
      if (type === "auto") type = detectType(url);
      return {
        channel_number: Number(r.querySelector(".f-num").value),
        network_name: r.querySelector(".f-name").value.trim(),
        url,
        type,
      };
    });
    return normalize(list);
  }

  function saveEditor() {
    const list = collectEditor();
    if (!list.length) { alert("Add at least one channel with a URL."); return; }
    saveChannels(list);
    channels = list;
    el("modal").hidden = true;
    // keep watching the same channel number if it still exists
    const keep = currentIndex >= 0 ? channels.findIndex(
      (c) => c.network_name === channels[currentIndex]?.network_name) : -1;
    playChannel(keep >= 0 ? keep : 0);
  }

  // ===================================================================
  // Events
  // ===================================================================
  function wireEvents() {
    el("chan-up").addEventListener("click", () => tuneByOffset(1));
    el("chan-down").addEventListener("click", () => tuneByOffset(-1));
    el("key-clear").addEventListener("click", clearEntry);
    el("key-enter").addEventListener("click", () => commitEntry(true));
    document.querySelectorAll("[data-digit]").forEach((b) =>
      b.addEventListener("click", () => appendDigit(b.dataset.digit)));

    video.addEventListener("ended", onMediaEnded);

    el("btn-mute").addEventListener("click", toggleMute);
    el("btn-full").addEventListener("click", toggleFullscreen);
    el("volume").addEventListener("input", (e) => {
      video.volume = parseFloat(e.target.value);
      video.muted = video.volume === 0;
      unmuteHint.hidden = !video.muted;
      syncMuteButton();
    });
    unmuteHint.addEventListener("click", () => {
      video.muted = false;
      if (video.volume === 0) video.volume = 1;
      el("volume").value = video.volume;
      unmuteHint.hidden = true;
      syncMuteButton();
    });

    el("btn-edit").addEventListener("click", openEditor);
    el("modal-close").addEventListener("click", () => (el("modal").hidden = true));
    el("add-chan").addEventListener("click", () =>
      el("chan-editor").appendChild(rowFor({ channel_number: nextChannelNumber(), type: "auto" })));
    el("save-chan").addEventListener("click", saveEditor);
    el("reset-chan").addEventListener("click", () => {
      if (confirm("Reset channels to the bundled defaults?")) {
        localStorage.removeItem(STORE_KEY);
        location.reload();
      }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key >= "0" && e.key <= "9") appendDigit(e.key);
      else if (e.key === "ArrowUp") { e.preventDefault(); tuneByOffset(1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); tuneByOffset(-1); }
      else if (e.key === "Enter") commitEntry(true);
      else if (e.key === "Escape") clearEntry();
      else if (e.key.toLowerCase() === "m") toggleMute();
      else if (e.key.toLowerCase() === "f") toggleFullscreen();
    });
  }

  function nextChannelNumber() {
    const rows = [...document.querySelectorAll("#chan-editor .f-num")];
    const max = rows.reduce((m, r) => Math.max(m, Number(r.value) || 0), 1);
    return max + 1;
  }

  // ===================================================================
  // Init
  // ===================================================================
  async function init() {
    cacheDom();
    wireEvents();
    video.muted = true; // start muted so autoplay is permitted
    syncMuteButton();
    channels = await loadChannels();

    if (!channels.length) { showNoSignal(true); networkName.textContent = "No channels"; return; }

    const last = parseInt(localStorage.getItem(LAST_KEY) || "", 10);
    let start = channels.findIndex((c) => c.channel_number === last);
    if (start < 0) start = 0;
    playChannel(start, { withStatic: false });
  }

  // Expose the pure parser for testing under Node.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseListing, detectType, normalize };
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
