import json
import hashlib
import sqlite3
import time
import uuid
from pathlib import Path

from .hosts import readable_record


class Store:
    def __init__(self, root: Path):
        self.root = root
        (root / 'bodies').mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(root / 'history.sqlite3')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT, created REAL)')
        if 'archived' not in {row[1] for row in self.db.execute('PRAGMA table_info(sessions)')}:
            self.db.execute('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
        self.db.execute('CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, session TEXT, started REAL, summary TEXT, detail TEXT)')
        self.db.execute('CREATE INDEX IF NOT EXISTS flows_session ON flows(session, started)')
        self.db.commit()
        self.session = self.new_session()['id']

    def sessions(self):
        return [dict(id=row[0], name=row[1], created=row[2], archived=bool(row[3]))
                for row in self.db.execute('SELECT id,name,created,archived FROM sessions ORDER BY created DESC')]

    def archive_sessions(self):
        self.db.execute('UPDATE sessions SET archived=1 WHERE archived=0')
        self.db.commit()

    def new_session(self):
        item = {'id': uuid.uuid4().hex, 'name': time.strftime('Session · %d %b %H:%M:%S'), 'created': time.time(), 'archived': False}
        with self.db:
            # Includes sessions left active by a crash or an older CHLS build.
            self.db.execute('UPDATE sessions SET archived=1 WHERE archived=0')
            self.db.execute('INSERT INTO sessions (id,name,created,archived) VALUES (:id,:name,:created,:archived)', item)
        self.session = item['id']
        return item

    def body(self, flow_id, side, data):
        filename = f'{flow_id}-{side}-{hashlib.sha256(data).hexdigest()}' if data is not None else None
        if data is not None:
            file = self.root / 'bodies' / filename
            if not file.exists():
                file.write_bytes(data)
        return filename if data is not None else None

    def rename_session(self, session, name):
        result = self.db.execute('UPDATE sessions SET name=? WHERE id=?', (name, session))
        self.db.commit()
        return result.rowcount > 0

    def export_snapshot(self, session):
        item = next((s for s in self.sessions() if s['id'] == session), None)
        if item is None:
            return None
        rows = self.db.execute('SELECT detail FROM flows WHERE session=? ORDER BY started, id', (session,)).fetchall()
        return item, [row[0] for row in rows]

    def save(self, summary, detail):
        self.db.execute('INSERT OR REPLACE INTO flows VALUES (?,?,?,?,?)', (summary['id'], summary['session'], summary['started'], json.dumps(summary), json.dumps(detail)))
        self.db.commit()

    def flows(self, session, limit=10000):
        return [readable_record(json.loads(row[0])) for row in self.db.execute('SELECT summary FROM flows WHERE session=? ORDER BY started DESC LIMIT ?', (session, limit))]

    def detail(self, flow_id):
        row = self.db.execute('SELECT detail FROM flows WHERE id=?', (flow_id,)).fetchone()
        return readable_record(json.loads(row[0])) if row else None

    def clear(self, session):
        ids = {r[0] for r in self.db.execute('SELECT id FROM flows WHERE session=?', (session,))}
        self.db.execute('DELETE FROM flows WHERE session=?', (session,))
        self.db.commit()
        # Scan once rather than globbing the whole directory for every flow.
        for file in (self.root / 'bodies').iterdir():
            if file.name.rsplit('-', 2)[0] in ids or file.name.rsplit('-', 1)[0] in ids:
                file.unlink(missing_ok=True)
