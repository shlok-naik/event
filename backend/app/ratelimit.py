"""In-memory sliding-window rate limiting.

Single-process only; put a shared store (e.g. Redis) behind ``RateLimiter`` when running
several workers.
"""
import hashlib
import threading
import time
from collections import defaultdict, deque

from fastapi import Request

from app.errors import RateLimited


class RateLimiter:
    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()
        self.enabled = True

    def hit(self, key: str, limit: int, window: float) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, int(q[0] + window - now) + 1)
                raise RateLimited(f"Too many requests; try again in {retry}s")
            q.append(now)
            if len(self._hits) > 50_000:  # crude memory bound
                for k in [k for k, v in self._hits.items() if not v][:10_000]:
                    self._hits.pop(k, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def limit(bucket: str, max_calls: int, window_seconds: float, per: str = "ip"):
    """FastAPI dependency: ``Depends(limit("login", 10, 60))``.

    ``per="principal"`` keys on the bearer token instead of the IP (for logged-in actions).
    """

    def dependency(request: Request) -> None:
        ident = client_ip(request)
        if per == "principal":
            auth = request.headers.get("authorization", "")
            if auth:
                ident = hashlib.sha256(auth.encode()).hexdigest()[:24]
        limiter.hit(f"{bucket}:{ident}", max_calls, window_seconds)

    return dependency
