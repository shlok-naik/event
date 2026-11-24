"""Write the OpenAPI schema (all endpoints + shared data types) to docs/openapi.json.

    python scripts/export_openapi.py
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.db import Database  # noqa: E402
from app.main import create_app  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    settings = Settings(_env_file=None, database_url=f"sqlite:///{tmp}/schema.db", scheduler_enabled=False, media_dir=f"{tmp}/media")
    database = Database(settings.database_url)
    app = create_app(settings, database)
    out = ROOT / "docs" / "openapi.json"
    out.write_text(json.dumps(app.openapi(), indent=2) + "\n", encoding="utf-8")
    database.engine.dispose()
    print(f"Wrote {out} ({len(app.openapi()['paths'])} paths)")
