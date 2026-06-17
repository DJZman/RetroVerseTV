import os
import sys
import asyncio
import ipaddress
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, PlainTextResponse, JSONResponse

# Add paths for module imports
cwd = os.getcwd()
parent = os.path.abspath(os.path.join(cwd, os.pardir))
sys.path.append(cwd)
sys.path.append(parent)

from rabbitears.station_manager import StationManager
from .api import routers

_shutdown_queue = None
player_command_queue = None

@asynccontextmanager
async def _lifespan(app):
    if _shutdown_queue is not None:
        async def shutdown_monitor():
            while True:
                await asyncio.sleep(1)
                try:
                    msg = _shutdown_queue.get_nowait()
                    if msg == "shutdown":
                        os._exit(0)
                except Exception:
                    pass
        asyncio.get_event_loop().create_task(shutdown_monitor())
    yield

# Create FastAPI app
fapi = FastAPI(title="RabbitEars TV API", lifespan=_lifespan)

@fapi.get("/")
async def root():
    return FileResponse("rabbitears/rabbitears_server/static/index.html")

@fapi.get("/remote")
async def remote():
    return FileResponse("rabbitears/rabbitears_server/static/remote.html")

@fapi.get("/player")
async def webplayer():
    # The player is served as a static bundle so its relative asset paths resolve.
    return RedirectResponse("/webplayer/")

@fapi.get('/favicon.ico', include_in_schema=False)
async def favicon():
    return FileResponse("rabbitears/rabbitears_server/static/favicon.ico")

# Include routers from the api package
for router in routers:
    fapi.include_router(router)


def _is_lan_client(host: str) -> bool:
    """True for loopback / private / link-local addresses (i.e. on the LAN)."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


@fapi.middleware("http")
async def _restrict_catalog_to_lan(request, call_next):
    # /media is public ("accessible anywhere"); /catalog exposes the raw content
    # tree and is restricted to clients on the local network.
    if request.url.path.startswith("/catalog"):
        client = request.client.host if request.client else ""
        if not _is_lan_client(client):
            return PlainTextResponse(
                "Catalog access is restricted to the local network.",
                status_code=403,
            )
    return await call_next(request)


# Browser-playable video extensions (matches the web player's VIDEO_EXT).
_VIDEO_EXT = (".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".m3u8")


def _resolve_media_path(url_path, media_dir, catalog_dir):
    """Map a /media or /catalog URL path to a safe on-disk directory.

    Returns (base_url, abs_dir, is_catalog). Raises ValueError if the path is
    outside the allowed roots (path-traversal guard).
    """
    norm = "/" + (url_path or "").strip().strip("/")
    if norm == "/media" or norm.startswith("/media/"):
        base, root, is_cat, rel = "/media", media_dir, False, norm[len("/media"):]
    elif norm == "/catalog" or norm.startswith("/catalog/"):
        base, root, is_cat, rel = "/catalog", catalog_dir, True, norm[len("/catalog"):]
    else:
        raise ValueError("path must be under /media or /catalog")

    rel = rel.lstrip("/")
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, rel))
    if target != root_real and not target.startswith(root_real + os.sep):
        raise ValueError("path traversal")
    base_url = base if not rel else f"{base}/{rel}"
    return base_url, target, is_cat


@fapi.get("/api/list")
async def api_list(request: Request, path: str):
    """List subdirectories and browser-playable video files in a /media or
    /catalog directory.

    Lets the web player use bare folder channels on this server, which (unlike
    `python -m http.server`) does not auto-index static directories, and powers
    the editor's folder browser (the `dirs` field lets the UI drill into the
    tree and pick a folder without anyone hand-typing a path).
    """
    conf = StationManager().server_conf
    media_dir = conf.get("media_dir", "media")
    catalog_dir = conf.get("catalog_dir", "catalog")
    try:
        base_url, target, is_catalog = _resolve_media_path(path, media_dir, catalog_dir)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    if is_catalog:  # same LAN-only rule as the /catalog mount
        client = request.client.host if request.client else ""
        if not _is_lan_client(client):
            return JSONResponse({"error": "Catalog access is restricted to the local network."}, status_code=403)

    if not os.path.isdir(target):
        return JSONResponse({"error": "not a directory"}, status_code=404)

    dirs, files = [], []
    for name in sorted(os.listdir(target)):
        full = os.path.join(target, name)
        if os.path.isdir(full):
            dirs.append(f"{base_url}/{name}")
        elif name.lower().endswith(_VIDEO_EXT) and os.path.isfile(full):
            files.append(f"{base_url}/{name}")

    # Parent for the browser's "Up" control; None at a mount root (/media, /catalog).
    norm = base_url.rstrip("/")
    parent = None if norm in ("/media", "/catalog") else (norm.rsplit("/", 1)[0] or None)
    return {"path": base_url, "parent": parent, "dirs": dirs, "files": files}


def run_with_shutdown_queue(shutdown_queue, command_queue):
    import logging

    class PlayerStatusFilter(logging.Filter):
        def filter(self, record):
            return ('/player/status' not in record.getMessage())

    logging.getLogger("uvicorn.access").addFilter(PlayerStatusFilter())

    global player_command_queue, _shutdown_queue
    player_command_queue = command_queue
    _shutdown_queue = shutdown_queue
    fapi.state.player_command_queue = command_queue

    fapi.mount("/static", StaticFiles(directory="rabbitears/rabbitears_server/static", html="true"), name="static")
    if os.path.isdir("webplayer"):
        fapi.mount("/webplayer", StaticFiles(directory="webplayer", html="true"), name="webplayer")
    os.makedirs("runtime/guide_videos", exist_ok=True)
    fapi.mount("/guide_videos", StaticFiles(directory="runtime/guide_videos"), name="guide_videos")
    conf = StationManager().server_conf
    # Serve local video files over HTTP for the web player. Two mounts:
    #   /media   - curated folder, reachable from anywhere the server is.
    #   /catalog - the existing RabbitEars content tree, LAN-only (see middleware).
    media_dir = conf.get("media_dir", "media")
    os.makedirs(media_dir, exist_ok=True)
    fapi.mount("/media", StaticFiles(directory=media_dir), name="media")
    catalog_dir = conf.get("catalog_dir", "catalog")
    os.makedirs(catalog_dir, exist_ok=True)
    fapi.mount("/catalog", StaticFiles(directory=catalog_dir), name="catalog")
    uvicorn.run(fapi, host=conf["server_host"], port=conf["server_port"])


def mount_rabbitears_api():
    import logging
    
    class PlayerStatusFilter(logging.Filter):
        def filter(self, record):
            return ('/player/status' not in record.getMessage())
    
    logging.getLogger("uvicorn.access").addFilter(PlayerStatusFilter())
    
    fapi.state.player_command_queue = None
    fapi.mount("/static", StaticFiles(directory="rabbitears/rabbitears_server/static", html="true"), name="static")
    if os.path.isdir("webplayer"):
        fapi.mount("/webplayer", StaticFiles(directory="webplayer", html="true"), name="webplayer")
    os.makedirs("runtime/guide_videos", exist_ok=True)
    fapi.mount("/guide_videos", StaticFiles(directory="runtime/guide_videos"), name="guide_videos")
    conf = StationManager().server_conf
    # Serve local video files over HTTP for the web player. Two mounts:
    #   /media   - curated folder, reachable from anywhere the server is.
    #   /catalog - the existing RabbitEars content tree, LAN-only (see middleware).
    media_dir = conf.get("media_dir", "media")
    os.makedirs(media_dir, exist_ok=True)
    fapi.mount("/media", StaticFiles(directory=media_dir), name="media")
    catalog_dir = conf.get("catalog_dir", "catalog")
    os.makedirs(catalog_dir, exist_ok=True)
    fapi.mount("/catalog", StaticFiles(directory=catalog_dir), name="catalog")
    uvicorn.run(fapi, host=conf["server_host"], port=conf["server_port"])


# Method 1: Basic uvicorn.run()
if __name__ == "__main__":
    mount_rabbitears_api()
