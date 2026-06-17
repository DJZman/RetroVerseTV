# RabbitEars TV — Web Player

A self-contained, "access anywhere" multi-stream player with the classic
RabbitEars TV remote UI. Channels are plain stream URLs (HLS `.m3u8`, MP4/WebM,
or YouTube) that play **directly in the browser** — no transcoding backend
required — so you can host the `webplayer/` folder anywhere (or even open it
from disk) and flip channels from any device.

![retro remote + screen]()

## Features

- **Retro TV remote** — seven-segment channel readout, Channel Up/Down, and a
  numeric keypad, carried over from the original RabbitEars TV remote.
- **In-browser playback** — HLS via [hls.js](https://github.com/video-dev/hls.js)
  (native HLS on Safari/iOS), progressive MP4/WebM, and YouTube embeds.
- **Loop / folder channels** — point a channel at a folder or playlist and it
  plays through everything, auto-advancing and looping (sequential or shuffle).
- **Channel editor** — add/remove/rename streams in the browser; saved to
  `localStorage`, so each device keeps its own lineup.
- **Retro touches** — TV-static channel-change effect, CRT scanlines, an
  on-screen channel banner, and a "NO SIGNAL" screen for empty channels.
- **Keyboard shortcuts** — `0–9` + `Enter` to tune, `↑/↓` to change channel,
  `M` mute, `F` fullscreen.

## Running it

**Anywhere (static):** serve the folder with any static host, e.g.

```bash
cd webplayer
python3 -m http.server 8080
# open http://localhost:8080
```

Or open `webplayer/index.html` directly — it falls back to a few built-in demo
channels when `channels.json` can't be fetched (e.g. over `file://`).

**Through the RabbitEars TV server:** when the RabbitEars web server is running, the
player is mounted automatically at:

```
http://<host>:<port>/player        (redirects to /webplayer/)
```

## Configuring channels

Edit `channels.json`, or click **☰ Channels** in the player to edit live. Each
channel mirrors the RabbitEars stream schema:

```json
{
  "channels": [
    {
      "channel_number": 2,
      "network_name": "Big Buck Bunny",
      "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      "type": "hls",
      "title": "Open movie · HLS demo stream"
    }
  ]
}
```

- `type` may be `hls`, `mp4`, `youtube`, `folder`, or `auto` (detected from the
  URL).
- In-browser edits are stored per-device in `localStorage` and take precedence
  over `channels.json`. Use **Reset to defaults** to clear them.

## Loop / folder channels

A channel can play through a whole folder of videos instead of a single file —
a simple "loop channel" that auto-advances to the next clip and loops at the
end. (This is *not* the full FieldStation42 schedule: no commercials, bumps, or
time-of-day programming — just continuous playback of the list.)

Three ways to define one:

```json
{ "channel_number": 5, "network_name": "Cartoons",
  "url": "/media/cartoons/", "type": "folder", "order": "shuffle" }
```

```json
{ "channel_number": 6, "network_name": "Saturday AM",
  "url": "/media/playlist.m3u", "type": "folder" }
```

```json
{ "channel_number": 7, "network_name": "Shorts",
  "playlist": ["/media/a.mp4", "/media/b.mp4", "/media/c.webm"] }
```

- **`folder`** points at either a **directory** or an **`.m3u` / `.json`**
  playlist file. Directories work two ways: hosts that auto-index (e.g.
  `python3 -m http.server`) are read directly, and on the RabbitEars app server
  the player falls back to its `/api/list` endpoint, so a bare `/media/...` or
  `/catalog/...` folder works there too (no `.m3u` needed).
- **`order`** is `sequential` (default, natural-sorted by filename) or
  `shuffle`.
- Only browser-playable files are included (`.mp4`, `.m4v`, `.webm`, `.ogv`,
  `.ogg`, `.mov`, `.m3u8`); the folder must be same-origin or CORS-enabled.

## Playing local video files

The browser only plays files reachable over HTTP (not raw `file://` paths), and
only web-friendly formats — **MP4 (H.264/AAC)** and **WebM**. Other formats
(MKV, AVI, etc.) need transcoding first.

When the RabbitEars server is running it exposes local video over HTTP via two mounts:

| Mount      | Folder (configurable)        | Reachable from        |
| ---------- | ---------------------------- | --------------------- |
| `/media`   | `media/` (`media_dir`)       | **Anywhere** the server is reachable |
| `/catalog` | `catalog/` (`catalog_dir`)   | **LAN only** (loopback / private / link-local clients) |

Use `/media` for content you want available anywhere — drop files in `media/`:

```json
{ "channel_number": 3, "network_name": "My Tape",
  "url": "/media/show.mp4", "type": "mp4" }
```

Use `/catalog` to reach your existing RabbitEars content without copying it. Its URL
mirrors the `content_dir` paths in your station configs (e.g.
`catalog/nbc_catalog/show.mp4` → `/catalog/nbc_catalog/show.mp4`):

```json
{ "channel_number": 4, "network_name": "NBC Tape",
  "url": "/catalog/nbc_catalog/show.mp4", "type": "mp4" }
```

`/catalog` returns **403** for non-LAN clients, since it exposes the raw content
tree (including catalog index files). If you front the server with a reverse
proxy, the LAN check sees the proxy's address — restrict `/catalog` at the proxy
in that setup.

Without the RabbitEars server, serve any folder with a static host
(`python3 -m http.server`) and use that URL instead.

## Notes / limitations

- Streams must be reachable from the **viewer's** browser and (for non-YouTube
  sources) sent with permissive CORS headers — this is a client-side player.
- Autoplay starts muted per browser policy; tap **🔊 / "Tap to unmute"** for
  sound.
