"""
database.py — SQLite storage for accounts and quizzes
================================================================
Anyone can create an account to build and host quizzes, or just
to test their own. Students/guests joining a live quiz are NOT
stored here at all — they type a display name for that session
only, so there's no extra personal data to protect
for them. Account passwords are always stored hashed, never in
plain text.
"""

import os
import sqlite3
from pathlib import Path
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = os.environ.get(
    "DATABASE_PATH", str(Path(__file__).resolve().with_name("quiz.db"))
)


def get_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            show_correct_answer INTEGER NOT NULL DEFAULT 0,
            show_scoreboard INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (owner_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            question_text TEXT NOT NULL,
            choice_a TEXT NOT NULL,
            choice_b TEXT NOT NULL,
            choice_c TEXT,
            choice_d TEXT,
            correct_letter TEXT NOT NULL,
            time_limit INTEGER NOT NULL DEFAULT 30,
            position INTEGER NOT NULL,
            FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
        );
    """)
    quiz_columns = {row["name"] for row in conn.execute("PRAGMA table_info(quizzes)")}
    if "show_correct_answer" not in quiz_columns:
        conn.execute("ALTER TABLE quizzes ADD COLUMN show_correct_answer INTEGER NOT NULL DEFAULT 0")
    if "show_scoreboard" not in quiz_columns:
        conn.execute("ALTER TABLE quizzes ADD COLUMN show_scoreboard INTEGER NOT NULL DEFAULT 0")
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(questions)")}
    if "time_limit" not in columns:
        conn.execute("ALTER TABLE questions ADD COLUMN time_limit INTEGER NOT NULL DEFAULT 30")
    conn.commit()
    conn.close()


# --------------------------------------------------------------------------
# Accounts (anyone — host their own quizzes, or just test one out)
# --------------------------------------------------------------------------
def create_user(email, password):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (?, ?)",
            (email, generate_password_hash(password)),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False  # email already registered
    finally:
        conn.close()


def verify_user(email, password):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    if row and check_password_hash(row["password_hash"], password):
        return dict(row)
    return None


def get_user(user_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# --------------------------------------------------------------------------
# Quizzes and questions
# --------------------------------------------------------------------------
def create_quiz(owner_id, title, questions, show_correct_answer=False, show_scoreboard=False):
    """
    questions: list of dicts with keys
    question_text, choice_a, choice_b, choice_c, choice_d, correct_letter, time_limit
    """
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO quizzes (owner_id, title, show_correct_answer, show_scoreboard) VALUES (?, ?, ?, ?)",
        (owner_id, title, int(show_correct_answer), int(show_scoreboard)),
    )
    quiz_id = cur.lastrowid
    for i, q in enumerate(questions):
        conn.execute(
            """INSERT INTO questions
               (quiz_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_letter, time_limit, position)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (quiz_id, q["question_text"], q["choice_a"], q["choice_b"],
             q.get("choice_c"), q.get("choice_d"), q["correct_letter"], q.get("time_limit", 30), i),
        )
    conn.commit()
    conn.close()
    return quiz_id


def get_quiz_for_edit(quiz_id, owner_id):
    """Raw rows (not the display-ready shape) so the edit form can pre-fill
    the pipe-delimited textarea with the quiz's current content."""
    conn = get_db()
    quiz = conn.execute(
        "SELECT * FROM quizzes WHERE id = ? AND owner_id = ?", (quiz_id, owner_id)
    ).fetchone()
    if not quiz:
        conn.close()
        return None
    questions = conn.execute(
        "SELECT * FROM questions WHERE quiz_id = ? ORDER BY position", (quiz_id,)
    ).fetchall()
    conn.close()
    return {
        "id": quiz["id"],
        "title": quiz["title"],
        "show_correct_answer": bool(quiz["show_correct_answer"]),
        "show_scoreboard": bool(quiz["show_scoreboard"]),
        "questions": [dict(q) for q in questions],
    }


def update_quiz(quiz_id, owner_id, title, questions, show_correct_answer=False, show_scoreboard=False):
    """Overwrites a quiz's title and questions. Only the owner can update it.
    Returns True if the quiz was found and updated, False otherwise."""
    conn = get_db()
    owned = conn.execute(
        "SELECT id FROM quizzes WHERE id = ? AND owner_id = ?", (quiz_id, owner_id)
    ).fetchone()
    if not owned:
        conn.close()
        return False
    conn.execute(
        "UPDATE quizzes SET title = ?, show_correct_answer = ?, show_scoreboard = ? WHERE id = ?",
        (title, int(show_correct_answer), int(show_scoreboard), quiz_id),
    )
    conn.execute("DELETE FROM questions WHERE quiz_id = ?", (quiz_id,))
    for i, q in enumerate(questions):
        conn.execute(
            """INSERT INTO questions
               (quiz_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_letter, time_limit, position)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (quiz_id, q["question_text"], q["choice_a"], q["choice_b"],
             q.get("choice_c"), q.get("choice_d"), q["correct_letter"], q.get("time_limit", 30), i),
        )
    conn.commit()
    conn.close()
    return True


def list_quizzes(owner_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title FROM quizzes WHERE owner_id = ? ORDER BY id DESC", (owner_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_quiz(quiz_id, owner_id=None):
    conn = get_db()
    if owner_id is not None:
        quiz = conn.execute(
            "SELECT * FROM quizzes WHERE id = ? AND owner_id = ?", (quiz_id, owner_id)
        ).fetchone()
    else:
        quiz = conn.execute("SELECT * FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
    if not quiz:
        conn.close()
        return None
    questions = conn.execute(
        "SELECT * FROM questions WHERE quiz_id = ? ORDER BY position", (quiz_id,)
    ).fetchall()
    conn.close()
    return {
        "id": quiz["id"],
        "title": quiz["title"],
        "show_correct_answer": bool(quiz["show_correct_answer"]),
        "show_scoreboard": bool(quiz["show_scoreboard"]),
        "questions": [
            {
                "question": q["question_text"],
                "choices": {
                    k: v for k, v in {
                        "A": q["choice_a"], "B": q["choice_b"],
                        "C": q["choice_c"], "D": q["choice_d"],
                    }.items() if v
                },
                "answer": q["correct_letter"],
                "time_limit": q["time_limit"],
            }
            for q in questions
        ],
    }