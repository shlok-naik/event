"""Application settings, loaded from environment variables / a local .env file.

Secrets (API keys, SMTP passwords) are only ever read from the environment and are
never returned by any endpoint or written to logs.
"""
from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Event App API"
    database_url: str = "sqlite:///./event.db"
    frontend_base_url: str = "http://localhost:5173"
    cors_origins: list[str] = ["http://localhost:5173"]

    # Sessions
    user_session_ttl_days: int = 30
    guest_session_ttl_days: int = 30
    invitation_ttl_days: int = 14
    magic_link_ttl_minutes: int = 30

    # Google Maps
    google_maps_api_key: SecretStr | None = None
    google_maps_timeout_seconds: float = 5.0

    # Email
    email_backend: str = "console"  # console | smtp | memory
    email_from: str = "Event App <no-reply@example.com>"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_use_tls: bool = True

    # Push notifications (external notification API)
    notification_backend: str = "log"  # log | webhook | memory
    notification_webhook_url: str | None = None
    notification_api_key: SecretStr | None = None
    # Deliver push/email in a background thread after commit (tests set this False).
    push_async: bool = True

    # Background jobs
    scheduler_enabled: bool = True
    scheduler_interval_seconds: int = 60
    event_default_duration_hours: int = 3
    event_delete_grace_hours: int = 1

    # Rate limiting
    rate_limit_enabled: bool = True

    # Uploads
    media_dir: str = "media"
    max_image_bytes: int = 2 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
