/* RetroVerseTV — Web Player
 *
 * A self-contained, "access anywhere" multi-stream player. Channels are plain
 * stream URLs (HLS / MP4 / WebM / YouTube) played directly in the browser, so
 * no transcoding backend is required. The retro TV remote (seven-seg display,
 * channel up/down, keypad) drives which stream is on screen.
 */

(() => {
  "use strict";

  const STORE_KEY = "rvtv_channels";
  const LAST_KEY = "rvtv_last_channel";

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

  // ---- DOM ----
  const el = (id) => document.getElementById(id);
  const screen = el("screen");
  const video = el("video");
  const yt = el("yt");
  const staticCanvas = el("static");
  const osd = el("osd");
  const osdChan = el("osd-chan");
  const osdName = el("osd-name");
  const sevenSeg = el("current-channel");
  const networkName = el("network-name");
  const titleEl = el("title");
  const entryEl = el("entry");
  const unmuteHint = el("unmute-hint");

  // ---- State ----
  let channels = [];
  let currentIndex = -1;
  let hls = null;
  let entryBuffer = "";
  let entryTimer = null;
  let osdTimer = null;
  let staticRAF = null;
  let staticStop = 0;

  // ===================================================================
  // Channel data (load / persist)
  // ===================================================================
  function normalize(list) {
    return (list || [])
      .map((c, i) => ({
        channel_number: Number(c.channel_number ?? c.channel ?? i + 1),
        network_name: c.network_name || c.name || `Channel ${i + 1}`,
        url: (c.url || "").trim(),
        type: c.type || detectType(c.url || ""),
        title: c.title || "",
      }))
      .filter((c) => c.url)
      .sort((a, b) => a.channel_number - b.channel_number);
  }

  function detectType(url) {
    const u = url.toLowerCase();
    if (/youtube\.com|youtu\.be/.test(u)) return "youtube";
    if (u.includes(".m3u8")) return "hls";
    return "mp4";
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

  function playChannel(index, { withStatic = true } = {}) {
    if (index < 0 || index >= channels.length) return;
    currentIndex = index;
    const ch = channels[index];

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
        // mute=1 keeps autoplay allowed; user can unmute on YouTube's own UI
        yt.src = `https://www.youtube.com/embed/${id}?autoplay=1&mute=${video.muted ? 1 : 0}&playsinline=1&rel=0`;
      } else {
        showNoSignal(true);
      }
      return;
    }

    screen.classList.remove("is-youtube");

    if (ch.type === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
      // Use hls.js where native HLS is unavailable (Chrome, Firefox)
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(ch.url);
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
    video.src = ch.url;
    video.addEventListener("error", () => showNoSignal(true), { once: true });
    safePlay();
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
      sevenSeg.textContent = String(num).padStart(2, "0");
      networkName.textContent = "";
      titleEl.textContent = "";
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
    titleEl.textContent = ch.title || "";
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
      `<div class="chan-head"><span>Ch #</span><span>Name</span><span>Stream URL</span><span>Type</span><span></span></div>`;
    channels.forEach((c) => wrap.appendChild(rowFor(c)));
    el("modal").hidden = false;
  }

  function rowFor(c = {}) {
    const row = document.createElement("div");
    row.className = "chan-row";
    row.innerHTML = `
      <input class="f-num" type="number" value="${c.channel_number ?? ""}" placeholder="#">
      <input class="f-name" type="text" value="${escapeAttr(c.network_name || "")}" placeholder="Name">
      <input class="f-url" type="text" value="${escapeAttr(c.url || "")}" placeholder="https://… .m3u8 / .mp4 / youtube">
      <select class="f-type">
        ${["auto", "hls", "mp4", "youtube"].map((t) =>
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

  document.addEventListener("DOMContentLoaded", init);
})();
