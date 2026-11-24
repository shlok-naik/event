"""Concurrent RSVPs and task claims, each thread with its own DB session/connection."""
import threading
from datetime import timedelta

from sqlalchemy import func, select

from app.db import utcnow
from app.errors import Conflict
from app.models import RSVP, Event, Group, GroupMembership, Guest, Task, TaskAssignment, User
from app.security import principal_from_guest, principal_from_user
from app.services import rsvps, tasks


def _seed(database, n_guests, max_participants):
    db = database.SessionLocal()
    owner = User(email="o@example.com", display_name="O", password_hash="x")
    db.add(owner)
    db.flush()
    group = Group(name="G", created_by_user_id=owner.id)
    db.add(group)
    db.flush()
    db.add(GroupMembership(group_id=group.id, user_id=owner.id, role="owner"))
    guests = []
    for i in range(n_guests):
        g = Guest(email=f"g{i}@example.com", display_name=f"G{i}")
        db.add(g)
        db.flush()
        db.add(GroupMembership(group_id=group.id, guest_id=g.id))
        guests.append(g)
    start = utcnow() + timedelta(days=2)
    event = Event(creator_user_id=owner.id, name="E", starts_at=start, expires_at=start + timedelta(hours=4), min_participants=1, max_participants=max_participants)
    db.add(event)
    db.flush()
    from app.models import EventGroup

    db.add(EventGroup(event_id=event.id, group_id=group.id))
    task = Task(event_id=event.id, title="T")
    db.add(task)
    db.commit()
    out = ([principal_from_guest(g) for g in guests], principal_from_user(owner), event.id, task.id)
    db.close()
    return out


def _race(database, fn, principals):
    barrier = threading.Barrier(len(principals))
    results = []
    lock = threading.Lock()

    def worker(p):
        db = database.SessionLocal()
        try:
            barrier.wait()
            fn(db, p)
            outcome = "ok"
        except Conflict as exc:
            outcome = exc.code
        finally:
            db.close()
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker, args=(p,)) for p in principals]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_concurrent_rsvps_never_exceed_max(app):
    database = app.state.database
    guests, _, event_id, _ = _seed(database, n_guests=12, max_participants=5)
    results = _race(database, lambda db, p: rsvps.join(db, p, event_id), guests)
    assert results.count("ok") == 5
    assert results.count("event_full") == 7
    db = database.SessionLocal()
    assert db.scalar(select(func.count()).select_from(RSVP).where(RSVP.event_id == event_id)) == 5
    assert db.get(Event, event_id).participant_count == 5
    db.close()


def test_concurrent_duplicate_rsvp_counts_once(app):
    database = app.state.database
    guests, _, event_id, _ = _seed(database, n_guests=1, max_participants=None)
    results = _race(database, lambda db, p: rsvps.join(db, p, event_id), [guests[0]] * 6)
    assert results.count("ok") == 1
    db = database.SessionLocal()
    assert db.get(Event, event_id).participant_count == 1
    db.close()


def test_concurrent_task_claims_single_winner(app):
    database = app.state.database
    guests, _, event_id, task_id = _seed(database, n_guests=10, max_participants=None)
    db = database.SessionLocal()
    for g in guests:
        rsvps.join(db, g, event_id)
    db.close()
    results = _race(database, lambda db, p: tasks.claim(db, p, event_id, task_id), guests)
    assert results.count("ok") == 1
    assert results.count("task_already_claimed") == 9
    db = database.SessionLocal()
    assert db.scalar(select(func.count()).select_from(TaskAssignment).where(TaskAssignment.task_id == task_id)) == 1
    db.close()
