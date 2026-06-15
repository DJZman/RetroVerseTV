# RetroVerseTV — Web Player

A self-contained, "access anywhere" multi-stream player with the classic
RetroVerseTV remote UI. Channels are plain stream URLs (HLS `.m3u8`, MP4/WebM,
or YouTube) that play **directly in the browser** — no transcoding backend
required — so you can host the `webplayer/` folder anywhere (or even open it
from disk) and flip channels from any device.

![retro remote + screen]()

## Features

- **Retro TV remote** — seven-segment channel readout, Channel Up/Down, and a
  numeric keypad, carried over from the original FieldStation42 remote.
- **In-browser playback** — HLS via [hls.js](https://github.com/video-dev/hls.js)
  (native HLS on Safari/iOS), progressive MP4/WebM, and YouTube embeds.
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

**Through the FieldStation42 server:** when the FS42 web server is running, the
player is mounted automatically at:

```
http://<host>:<port>/player        (redirects to /webplayer/)
```

## Configuring channels

Edit `channels.json`, or click **☰ Channels** in the player to edit live. Each
channel mirrors the FS42 stream schema:

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

- `type` may be `hls`, `mp4`, `youtube`, or `auto` (detected from the URL).
- In-browser edits are stored per-device in `localStorage` and take precedence
  over `channels.json`. Use **Reset to defaults** to clear them.

## Playing local video files

The browser only plays files reachable over HTTP (not raw `file://` paths), and
only web-friendly formats — **MP4 (H.264/AAC)** and **WebM**. Other formats
(MKV, AVI, etc.) need transcoding first.

When the FS42 server is running it exposes local video over HTTP via two mounts:

| Mount      | Folder (configurable)        | Reachable from        |
| ---------- | ---------------------------- | --------------------- |
| `/media`   | `media/` (`media_dir`)       | **Anywhere** the server is reachable |
| `/catalog` | `catalog/` (`catalog_dir`)   | **LAN only** (loopback / private / link-local clients) |

Use `/media` for content you want available anywhere — drop files in `media/`:

```json
{ "channel_number": 3, "network_name": "My Tape",
  "url": "/media/show.mp4", "type": "mp4" }
```

Use `/catalog` to reach your existing FS42 content without copying it. Its URL
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

Without the FS42 server, serve any folder with a static host
(`python3 -m http.server`) and use that URL instead.

## Notes / limitations

- Streams must be reachable from the **viewer's** browser and (for non-YouTube
  sources) sent with permissive CORS headers — this is a client-side player.
- Autoplay starts muted per browser policy; tap **🔊 / "Tap to unmute"** for
  sound.
