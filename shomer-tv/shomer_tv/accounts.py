"""
accounts.py — Cuentas de clientes y suscripciones (SQLite, sin dependencias).

- Contraseñas con scrypt + sal por usuario.
- Sesiones con token aleatorio en cookie HttpOnly (`shomer_session`).
- Cada cuenta puede tener como máximo MAX_SESSIONS sesiones abiertas: al entrar en
  un dispositivo nuevo se cierra la más antigua (evita compartir la cuenta).
- La suscripción es una fecha `paid_until`; el operador la extiende desde /admin
  (pago por transferencia, OXXO, enlace de pago…) o por la línea de comandos.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time

MAX_SESSIONS = 2
SESSION_DAYS = 60
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DAY = 86400


def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)


class Accounts:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # El servidor atiende en varios hilos: toda consulta pasa por el candado.
        self._lock = threading.RLock()
        with self._lock, self._db:
            self._db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    email TEXT PRIMARY KEY, name TEXT, salt BLOB, pw BLOB,
                    paid_until REAL DEFAULT 0, created REAL, note TEXT DEFAULT '');
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY, email TEXT, created REAL, expires REAL);
            """)

    def _one(self, sql: str, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchone()

    # ------------------------------------------------------------- clientes
    def signup(self, email: str, password: str, name: str = "") -> dict:
        email = email.strip().lower()
        if not EMAIL_RE.match(email) or len(email) > 200:
            raise ValueError("correo inválido")
        if len(password) < 8:
            raise ValueError("la contraseña debe tener al menos 8 caracteres")
        salt = os.urandom(16)
        try:
            with self._lock, self._db:
                self._db.execute("INSERT INTO users (email, name, salt, pw, created) VALUES (?,?,?,?,?)",
                                 (email, name.strip()[:100], salt, _hash(password, salt), time.time()))
        except sqlite3.IntegrityError:
            raise ValueError("ya existe una cuenta con ese correo") from None
        return self.login(email, password)

    def login(self, email: str, password: str) -> dict:
        email = email.strip().lower()
        row = self._one("SELECT salt, pw FROM users WHERE email=?", (email,))
        # Se calcula el hash aunque el usuario no exista, para no revelarlo por el tiempo de respuesta.
        ok = hmac.compare_digest(_hash(password, row["salt"] if row else b"x" * 16),
                                 row["pw"] if row else b"")
        if not row or not ok:
            raise ValueError("correo o contraseña incorrectos")
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock, self._db:
            self._db.execute("INSERT INTO sessions VALUES (?,?,?,?)", (token, email, now, now + SESSION_DAYS * DAY))
            self._db.execute("""DELETE FROM sessions WHERE email=? AND token NOT IN
                                (SELECT token FROM sessions WHERE email=? ORDER BY created DESC LIMIT ?)""",
                             (email, email, MAX_SESSIONS))
        return {"token": token, **self.user(email)}

    def logout(self, token: str):
        with self._lock, self._db:
            self._db.execute("DELETE FROM sessions WHERE token=?", (token,))

    def session_user(self, token: str) -> dict | None:
        if not token:
            return None
        row = self._one("SELECT email FROM sessions WHERE token=? AND expires>?", (token, time.time()))
        return self.user(row["email"]) if row else None

    def user(self, email: str) -> dict | None:
        row = self._one("SELECT email, name, paid_until, created, note FROM users WHERE email=?", (email,))
        if not row:
            return None
        u = dict(row)
        u["active"] = u["paid_until"] > time.time()
        return u

    # ------------------------------------------------------------- operador
    def list_users(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT email FROM users ORDER BY created DESC").fetchall()
        return [self.user(r["email"]) for r in rows]

    def extend(self, email: str, days: float, note: str | None = None) -> dict:
        """Suma `days` a la suscripción (desde hoy si estaba vencida). days<=0 la cancela."""
        u = self.user(email.strip().lower())
        if not u:
            raise ValueError("no existe esa cuenta")
        now = time.time()
        until = 0 if days <= 0 else max(u["paid_until"], now) + days * DAY
        with self._lock, self._db:
            self._db.execute("UPDATE users SET paid_until=?, note=COALESCE(?, note) WHERE email=?",
                             (until, note, u["email"]))
            if days <= 0:
                self._db.execute("DELETE FROM sessions WHERE email=?", (u["email"],))
        return self.user(u["email"])

    def delete(self, email: str):
        email = email.strip().lower()
        with self._lock, self._db:
            self._db.execute("DELETE FROM sessions WHERE email=?", (email,))
            self._db.execute("DELETE FROM users WHERE email=?", (email,))
