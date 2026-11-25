"""FastAPI application factory. Run with ``uvicorn app.main:app --reload``."""
import asyncio
import contextlib
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import Settings, get_settings
from app.db import Database
from app.errors import AppError, RateLimited
from app.ratelimit import client_ip, limiter
from app.routers import auth, events, groups, locations, notifications, ws
from app.scheduler import run_forever
from app.services.maps import MapsClient
from app.services.runtime import configure

logging.basicConfig(level=logging.INFO)
# httpx logs every request URL at INFO; the Geocoding API takes the key as a query
# parameter, so that would write the Google Maps key into the server log.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def create_app(settings: Settings | None = None, database: Database | None = None, maps: MapsClient | None = None) -> FastAPI:
    settings = settings or get_settings()
    database = database or Database(settings.database_url)
    database.create_all()
    runtime = configure(settings)
    runtime.database = database
    limiter.enabled = settings.rate_limit_enabled

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        task = None
        if settings.scheduler_enabled:
            task = asyncio.create_task(run_forever(database, settings.scheduler_interval_seconds))
        yield
        if task:
            task.cancel()

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Backend for a localised, group-based event organisation and messaging app. "
        "Authenticate with `Authorization: Bearer <token>` (user or guest session).",
        lifespan=lifespan,
    )
    app.state.database = database
    app.state.maps = maps or MapsClient(settings)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def global_rate_limit(request: Request, call_next):
        try:
            limiter.hit(f"global:{client_ip(request)}", 600, 60)
        except RateLimited as exc:
            return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=429)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        details = [{"loc": list(e["loc"]), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse({"error": {"code": "validation_error", "message": "Invalid request", "details": details}}, status_code=422)

    for r in (auth.router, groups.router, events.router, notifications.router, locations.router, ws.router):
        app.include_router(r)

    media = Path(settings.media_dir)
    media.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=media), name="media")

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok"}

    return app


_app: FastAPI | None = None


def __getattr__(name: str):
    """``uvicorn app.main:app`` builds the app lazily, so importing this module (e.g. in
    tests) has no side effects."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
