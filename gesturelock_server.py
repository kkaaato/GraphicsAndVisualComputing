"""
GestureLock — Server (Phase 2, restructured)
================================================
Same behavior as server_with_accounts.py, but the frontend now
lives in its own files instead of inline strings:

  templates/   -> HTML pages (Jinja2), one file per page
  static/      -> style.css and host.js

This file only holds routes, session/auth logic, and the
Socket.IO event handlers.

SETUP
-----
pip install flask flask-socketio eventlet werkzeug

RUN
---
python gesturelock_server.py
"""

import os
import threading
from functools import wraps

from flask import Flask, render_template, jsonify, request, session, redirect, url_for
from flask_socketio import SocketIO

import database as db

app = Flask(__name__)
# Set a real SECRET_KEY environment variable on your host (see deployment notes).
# This fallback is only safe for local testing on your own machine.
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-fallback-key")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

db.init_db()

state = {"questions": [], "q_index": 0, "locked_answer": None, "quiz_title": None}
state_lock = threading.Lock()


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = None
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        if not email or not password:
            error = "Email and password are required."
        elif db.create_user(email, password):
            return redirect(url_for("login"))
        else:
            error = "That email is already registered."
    return render_template("signup.html", error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = db.verify_user(email, password)
        if user:
            session["user_id"] = user["id"]
            session["email"] = user["email"]
            return redirect(url_for("dashboard"))
        error = "Incorrect email or password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------------------------------
# Quiz management
# --------------------------------------------------------------------------
@app.route("/dashboard")
@login_required
def dashboard():
    quizzes = db.list_quizzes(session["user_id"])
    return render_template("dashboard.html", quizzes=quizzes, email=session["email"])


@app.route("/quizzes/new", methods=["GET", "POST"])
@login_required
def new_quiz():
    error = None
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        raw = request.form.get("questions", "").strip()
        questions = []
        for line_no, line in enumerate(raw.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 4:
                error = f"Line {line_no} needs at least: question|choiceA|choiceB|correctLetter"
                break
            q_text, choice_a, choice_b = parts[0], parts[1], parts[2]
            choice_c = parts[3] if len(parts) > 4 else None
            choice_d = parts[4] if len(parts) > 5 else None
            correct = parts[-1].upper()
            if correct not in ("A", "B", "C", "D"):
                error = f"Line {line_no}: correct answer must be A, B, C, or D."
                break
            questions.append({
                "question_text": q_text, "choice_a": choice_a, "choice_b": choice_b,
                "choice_c": choice_c, "choice_d": choice_d, "correct_letter": correct,
            })
        if not error and title and questions:
            db.create_quiz(session["user_id"], title, questions)
            return redirect(url_for("dashboard"))
        if not error:
            error = "Add a title and at least one question."
    return render_template("new_quiz.html", error=error)


# --------------------------------------------------------------------------
# Live hosting + student-facing API
# --------------------------------------------------------------------------
@app.route("/host/<int:quiz_id>")
@login_required
def host_page(quiz_id):
    quiz = db.get_quiz(quiz_id, owner_id=session["user_id"])
    if not quiz or not quiz["questions"]:
        return redirect(url_for("dashboard"))
    with state_lock:
        state["questions"] = quiz["questions"]
        state["q_index"] = 0
        state["locked_answer"] = None
        state["quiz_title"] = quiz["title"]
    return render_template("host.html")


@app.route("/api/question")
def api_question():
    with state_lock:
        if not state["questions"]:
            return jsonify({"question": None})
        q = state["questions"][state["q_index"]]
        return jsonify({
            "index": state["q_index"],
            "total": len(state["questions"]),
            "question": q["question"],
            "choices": q["choices"],
            "locked_answer": state["locked_answer"],
        })


@app.route("/api/host_question")
def api_host_question():
    with state_lock:
        if not state["questions"]:
            return jsonify({"question": None})
        q = state["questions"][state["q_index"]]
        locked = state["locked_answer"]
        return jsonify({
            "index": state["q_index"],
            "total": len(state["questions"]),
            "quiz_title": state["quiz_title"],
            "question": q["question"],
            "choices": q["choices"],
            "answer": q["answer"],
            "locked_answer": locked,
            "is_correct": (locked == q["answer"]) if locked else None,
        })


@socketio.on("submit_answer")
def submit_answer(data):
    choice = (data or {}).get("choice")
    if choice not in ("A", "B", "C", "D"):
        return
    with state_lock:
        if state["locked_answer"] is not None:
            return
        state["locked_answer"] = choice
    socketio.emit("answer_locked", {"choice": choice})


@socketio.on("next_question")
def next_question():
    with state_lock:
        if not state["questions"]:
            return
        state["q_index"] = (state["q_index"] + 1) % len(state["questions"])
        state["locked_answer"] = None
        q = state["questions"][state["q_index"]]
        idx = state["q_index"]
    socketio.emit("question_update", {
        "index": idx, "total": len(state["questions"]),
        "question": q["question"], "choices": q["choices"],
    })


@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\nTeacher: http://<this-ip>:{port}/signup")
    print(f"Students: student_client.py --server http://<this-ip>:{port}\n")
    socketio.run(app, host="0.0.0.0", port=port)