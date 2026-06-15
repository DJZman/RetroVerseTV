import os
import sys
import asyncio
import ipaddress
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, PlainTextResponse

# Add paths for module imports
cwd = os.getcwd()
parent = os.path.abspath(os.path.join(cwd, os.pardir))
sys.path.append(cwd)
sys.path.append(parent)

from fs42.station_manager import StationManager
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
fapi = FastAPI(title="FieldStation42 API", lifespan=_lifespan)

@fapi.get("/")
async def root():
    return FileResponse("fs42/fs42_server/static/index.html")

@fapi.get("/remote")
async def remote():
    return FileResponse("fs42/fs42_server/static/remote.html")

@fapi.get("/player")
async def webplayer():
    # The player is served as a static bundle so its relative asset paths resolve.
    return RedirectResponse("/webplayer/")

@fapi.get('/favicon.ico', include_in_schema=False)
async def favicon():
    return FileResponse("fs42/fs42_server/static/favicon.ico")

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

    fapi.mount("/static", StaticFiles(directory="fs42/fs42_server/static", html="true"), name="static")
    if os.path.isdir("webplayer"):
        fapi.mount("/webplayer", StaticFiles(directory="webplayer", html="true"), name="webplayer")
    os.makedirs("runtime/guide_videos", exist_ok=True)
    fapi.mount("/guide_videos", StaticFiles(directory="runtime/guide_videos"), name="guide_videos")
    conf = StationManager().server_conf
    # Serve local video files over HTTP for the web player. Two mounts:
    #   /media   - curated folder, reachable from anywhere the server is.
    #   /catalog - the existing FS42 content tree, LAN-only (see middleware).
    media_dir = conf.get("media_dir", "media")
    os.makedirs(media_dir, exist_ok=True)
    fapi.mount("/media", StaticFiles(directory=media_dir), name="media")
    catalog_dir = conf.get("catalog_dir", "catalog")
    os.makedirs(catalog_dir, exist_ok=True)
    fapi.mount("/catalog", StaticFiles(directory=catalog_dir), name="catalog")
    uvicorn.run(fapi, host=conf["server_host"], port=conf["server_port"])


def mount_fs42_api():
    import logging
    
    class PlayerStatusFilter(logging.Filter):
        def filter(self, record):
            return ('/player/status' not in record.getMessage())
    
    logging.getLogger("uvicorn.access").addFilter(PlayerStatusFilter())
    
    fapi.state.player_command_queue = None
    fapi.mount("/static", StaticFiles(directory="fs42/fs42_server/static", html="true"), name="static")
    if os.path.isdir("webplayer"):
        fapi.mount("/webplayer", StaticFiles(directory="webplayer", html="true"), name="webplayer")
    os.makedirs("runtime/guide_videos", exist_ok=True)
    fapi.mount("/guide_videos", StaticFiles(directory="runtime/guide_videos"), name="guide_videos")
    conf = StationManager().server_conf
    # Serve local video files over HTTP for the web player. Two mounts:
    #   /media   - curated folder, reachable from anywhere the server is.
    #   /catalog - the existing FS42 content tree, LAN-only (see middleware).
    media_dir = conf.get("media_dir", "media")
    os.makedirs(media_dir, exist_ok=True)
    fapi.mount("/media", StaticFiles(directory=media_dir), name="media")
    catalog_dir = conf.get("catalog_dir", "catalog")
    os.makedirs(catalog_dir, exist_ok=True)
    fapi.mount("/catalog", StaticFiles(directory=catalog_dir), name="catalog")
    uvicorn.run(fapi, host=conf["server_host"], port=conf["server_port"])


# Method 1: Basic uvicorn.run()
if __name__ == "__main__":
    mount_fs42_api()
