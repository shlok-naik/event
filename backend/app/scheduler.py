"""Background jobs, run every ``SCHEDULER_INTERVAL_SECONDS`` inside the API process:
automatic event deletion, smart reminders, due reminders and the push outbox.
Each job can also be run manually: ``python -m app.scheduler``."""
import asyncio
import logging

from starlette.concurrency import run_in_threadpool

from app.services import cleanup, notifications, reminders

log = logging.getLogger("event.scheduler")


def run_jobs_once(database) -> dict:
    db = database.SessionLocal()
    results = {}
    try:
        for name, job in (
            ("purged_events", cleanup.purge_expired_events),
            ("smart_reminders", reminders.generate_smart_reminders),
            ("sent_reminders", reminders.run_due_reminders),
            ("pushed", notifications.flush_push_outbox),
        ):
            try:
                results[name] = job(db)
            except Exception:
                db.rollback()
                log.exception("Scheduled job %s failed", name)
    finally:
        db.close()
    return results


async def run_forever(database, interval: int) -> None:
    while True:
        await run_in_threadpool(run_jobs_once, database)
        await asyncio.sleep(interval)


if __name__ == "__main__":
    from app.config import get_settings
    from app.db import Database
    from app.services.runtime import configure

    settings = get_settings()
    rt = configure(settings)
    rt.database = Database(settings.database_url)
    rt.database.create_all()
    print(run_jobs_once(rt.database))
