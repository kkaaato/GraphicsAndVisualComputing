"""GestureLock — Flask + SocketIO server"""

import eventlet
eventlet.monkey_patch()  # must run before socket/ssl imports

import os
import re

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_socketio import SocketIO, emit

import database

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-insecure-key")
socketio = SocketIO(app, cors_allowed_origins="*")

# --------------------------------------------------------------------------
# Live session state (in-memory, one quiz at a time)
# --------------------------------------------------------------------------
live = {
    "quiz_id": None,
    "quiz": None,
    "index": 0,
    "locked_answer": None,
    "locked_name": None,
}


def current_question():
    """Payload shape shared by /api/question and the question_update event."""
    q = live["quiz"]
    if not q or not q["questions"]:
        return None
    item = q["questions"][min(live["index"], len(q["questions"]) - 1)]
    return {
        "index": live["index"],
        "total": len(q["questions"]),
        "question": item["question"],
        "choices": item["choices"],
    }


def host_payload():
    """Host view: adds the answer key and lock status on top of the base payload."""
    payload = current_question()
    if payload is None:
        return None
    item = live["quiz"]["questions"][payload["index"]]
    payload["answer"] = item["answer"]
    payload["locked_answer"] = live["locked_answer"]
    payload["is_correct"] = (
        live["locked_answer"] == item["answer"] if live["locked_answer"] else None
    )
    return payload


# --------------------------------------------------------------------------
# Auth routes
# --------------------------------------------------------------------------
@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        email = request.form["email"].strip().lower()
        password = request.form["password"]
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            return render_template("signup.html", error="Invalid email.")
        if len(password) < 6:
            return render_template("signup.html", error="Password too short.")
        if database.create_user(email, password):
            session["user_id"] = database.verify_user(email, password)["id"]
            return redirect(url_for("dashboard"))
        return render_template("signup.html", error="Email already registered.")
    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        user = database.verify_user(
            request.form["email"].strip().lower(), request.form["password"]
        )
        if user:
            session["user_id"] = user["id"]
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Wrong email or password.")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------------------------------
# Quiz management routes
# --------------------------------------------------------------------------
def parse_questions(raw):
    """Each line: question|A|B|C|D|correctLetter (C/D optional)."""
    questions = []
    for line in raw.strip().splitlines():
        parts = [p.strip() for p in line.split("|")]
        if not parts[0]:
            continue
        if len(parts) < 4 or parts[-1] not in ("A", "B", "C", "D"):
            return None
        q = {
            "question_text": parts[0],
            "choice_a": parts[1],
            "choice_b": parts[2],
            "choice_c": parts[3] if len(parts) > 4 else None,
            "choice_d": parts[4] if len(parts) > 5 else None,
            "correct_letter": parts[-1],
        }
        letters = {"A", "B"} | ({"C"} if q["choice_c"] else set()) | ({"D"} if q["choice_d"] else set())
        if q["correct_letter"] not in letters:
            return None
        questions.append(q)
    return questions or None


@app.route("/")
@app.route("/dashboard")
def dashboard():
    if "user_id" not in session:
        return redirect(url_for("login"))
    user = database.get_user(session["user_id"])
    return render_template(
        "dashboard.html", email=user["email"], quizzes=database.list_quizzes(user["id"])
    )


@app.route("/quiz/new", methods=["GET", "POST"])
def new_quiz():
    if "user_id" not in session:
        return redirect(url_for("login"))
    if request.method == "POST":
        questions = parse_questions(request.form["questions"])
        if questions is None:
            return render_template(
                "new_quiz.html", error="Format: question|A|B|C|D|correctLetter"
            )
        database.create_quiz(session["user_id"], request.form["title"].strip(), questions)
        return redirect(url_for("dashboard"))
    return render_template("new_quiz.html")


@app.route("/join")
def join_page():
    return render_template("join.html")


@app.route("/quiz/<int:quiz_id>/host")
def host_page(quiz_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    quiz = database.get_quiz(quiz_id, session["user_id"])
    if not quiz:
        return redirect(url_for("dashboard"))
    return render_template("host.html", quiz=quiz)


# --------------------------------------------------------------------------
# JSON API (used by student_client.py and host.js)
# --------------------------------------------------------------------------
@app.route("/api/login_check", methods=["POST"])
def api_login_check():
    data = request.get_json(force=True, silent=True) or {}
    user = database.verify_user(
        str(data.get("email", "")).strip().lower(), str(data.get("password", ""))
    )
    if user:
        return jsonify(ok=True, email=user["email"])
    return jsonify(ok=False), 401


@app.route("/api/question")
def api_question():
    q = current_question()
    return jsonify(q) if q else ("", 204)


@app.route("/api/host_question")
def api_host_question():
    return jsonify(host_payload() or {})


# --------------------------------------------------------------------------
# SocketIO events
# --------------------------------------------------------------------------
@socketio.on("next_question")
def on_next_question():
    """Host advances; wraps at the end and clears the lock."""
    if live["quiz"] is None:
        return
    live["index"] = (live["index"] + 1) % len(live["quiz"]["questions"])
    live["locked_answer"] = None
    live["locked_name"] = None
    emit("question_update", host_payload(), broadcast=True)


@socketio.on("submit_answer")
def on_submit_answer(data):
    """Joiner locks a choice; first lock wins for the current question."""
    if live["quiz"] is None or live["locked_answer"] is not None:
        return
    choice = str(data.get("choice", "")).upper()
    live["locked_answer"] = choice
    live["locked_name"] = str(data.get("name", "guest"))[:40]
    emit("answer_locked", host_payload(), broadcast=True)


@socketio.on("load_quiz")
def on_load_quiz(data):
    """Host page tells the server which quiz to serve; resets to question 0."""
    quiz = database.get_quiz(int(data.get("quiz_id", 0)))
    if not quiz or not quiz["questions"]:
        return
    live.update(
        quiz_id=quiz["id"], quiz=quiz, index=0,
        locked_answer=None, locked_name=None,
    )
    emit("question_update", host_payload(), broadcast=True)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
database.init_db()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
