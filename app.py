"""GestureLock — Flask + SocketIO server."""

import os
import re
import time

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_socketio import SocketIO, emit
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

import database

PREVIEW_INTERVAL_S = 0.2

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-insecure-key")
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=2_000_000,
)
score_ticket_serializer = URLSafeTimedSerializer(app.secret_key, salt="quiz-scoreboard")


@app.context_processor
def account_context():
    user_id = session.get("user_id")
    user = database.get_user(user_id) if user_id else None
    return {"logged_in_email": user["email"] if user else None}

# --------------------------------------------------------------------------
# Live session state (in-memory, one quiz at a time)
# --------------------------------------------------------------------------
live = {
    "quiz_id": None,
    "quiz": None,
    "index": 0,
    "locked_answer": None,
    "locked_name": None,
    "question_started_at": None,
    "started": False,
    "join_code": None,
    "host_sid": None,
    "participants": {},
    "answers": {},
    "ended": False,
    "scoreboard": None,
}

# Per-joiner session state, keyed by socket id. Gesture recognition runs in
# the browser with MediaPipe Tasks; the server receives only final answers.
joiners = {}


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
        "time_limit": item["time_limit"],
        "started_at": live["question_started_at"],
        "server_time": time.time(),
        "join_code": live["join_code"],
    }


def host_payload():
    """Host view: adds the answer key and lock status on top of the base payload."""
    payload = current_question()
    if payload is None:
        return None
    item = live["quiz"]["questions"][payload["index"]]
    payload["answer"] = item["answer"]
    payload["answers_received"] = len(live["answers"])
    return payload


def reset_joiners():
    """New question -> every joiner must gesture again."""
    for s in joiners.values():
        s.update(pointing=None, hold_start=None, locked=None)


def lock_answer(choice, name):
    """First lock of the current question wins; broadcast to host + joiners."""
    if live["quiz"] is None or live["locked_answer"] is not None:
        return False
    item = live["quiz"]["questions"][live["index"]]
    if time.time() - live["question_started_at"] >= item["time_limit"]:
        return False
    live["locked_answer"] = choice
    live["locked_name"] = name
    emit("answer_locked", host_payload(), broadcast=True)
    return True


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
    """Each line: question|A|B|C|D|correctLetter|seconds (C/D optional)."""
    questions = []
    for line in raw.strip().splitlines():
        parts = [p.strip() for p in line.split("|")]
        if not parts[0]:
            continue
        time_limit = 30
        if parts[-1].isdigit():
            time_limit = int(parts.pop())
        if not 5 <= time_limit <= 600:
            return None
        if len(parts) < 4 or parts[-1] not in ("A", "B", "C", "D"):
            return None
        q = {
            "question_text": parts[0],
            "choice_a": parts[1],
            "choice_b": parts[2],
            "choice_c": parts[3] if len(parts) > 4 else None,
            "choice_d": parts[4] if len(parts) > 5 else None,
            "correct_letter": parts[-1],
            "time_limit": time_limit,
        }
        letters = {"A", "B"} | ({"C"} if q["choice_c"] else set()) | ({"D"} if q["choice_d"] else set())
        if q["correct_letter"] not in letters:
            return None
        questions.append(q)
    return questions or None


@app.route("/")
def home():
    return render_template("home.html")


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
        questions = parse_questions(request.form.get("questions", ""))
        if questions is None:
            return render_template(
                "new_quiz.html", error="Format: question|A|B|C|D|correctLetter"
            )
        database.create_quiz(
            session["user_id"], request.form["title"].strip(), questions,
            show_correct_answer=request.form.get("show_correct_answer") == "1",
            show_scoreboard=request.form.get("show_scoreboard") == "1",
        )
        return redirect(url_for("dashboard", saved=1))
    return render_template("new_quiz.html")


@app.route("/quiz/<int:quiz_id>/edit", methods=["GET", "POST"])
def edit_quiz(quiz_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    quiz = database.get_quiz_for_edit(quiz_id, session["user_id"])
    if not quiz:
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        questions = parse_questions(request.form.get("questions", ""))
        if questions is None:
            return render_template("new_quiz.html", quiz=quiz, error="Add valid questions, answers, correct answers, and timers.")
        database.update_quiz(
            quiz_id, session["user_id"], request.form["title"].strip(), questions,
            show_correct_answer=request.form.get("show_correct_answer") == "1",
            show_scoreboard=request.form.get("show_scoreboard") == "1",
        )
        return redirect(url_for("dashboard", saved=1))
    return render_template("new_quiz.html", quiz=quiz)


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


@app.route("/quiz/<int:quiz_id>/scoreboard")
def scoreboard_page(quiz_id):
    if "user_id" not in session:
        return redirect(url_for("login"))
    quiz = database.get_quiz(quiz_id, session["user_id"])
    if not quiz:
        return redirect(url_for("dashboard"))
    if live["quiz_id"] != quiz_id or not live["ended"]:
        return redirect(url_for("host_page", quiz_id=quiz_id))
    return render_template("scoreboard.html", quiz=quiz, scoreboard=live["scoreboard"] or [])


@app.route("/join/scoreboard/<ticket>")
def participant_scoreboard_page(ticket):
    try:
        result = score_ticket_serializer.loads(ticket, max_age=86400)
    except (BadSignature, SignatureExpired):
        return redirect(url_for("join_page"))
    if (not live["ended"] or result.get("quiz_id") != live["quiz_id"]
            or result.get("sid") not in live["participants"]):
        return redirect(url_for("join_page"))
    participant = live["participants"][result["sid"]]
    return render_template(
        "scoreboard.html",
        quiz=live["quiz"],
        scoreboard=live["scoreboard"] or [],
        participant=True,
        personal_score=participant["score"],
        show_leaderboard=live["quiz"].get("show_scoreboard", False),
    )


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
    code = request.args.get("code", "").strip()
    if (not live["quiz"] or not live["started"] or live["ended"]
            or not code or code.upper() != live["join_code"]):
        return "", 204
    q = current_question()
    return jsonify(q) if q else ("", 204)


@app.route("/api/host_question")
def api_host_question():
    return jsonify(host_payload() or {})


# --------------------------------------------------------------------------
# SocketIO events
# --------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    joiners[request.sid] = {
        "name": "guest", "pointing": None, "hold_start": None, "locked": None,
    }


@socketio.on("disconnect")
def on_disconnect():
    joiners.pop(request.sid, None)
    participant = live["participants"].get(request.sid)
    if participant:
        participant["online"] = False
        if live["host_sid"]:
            socketio.emit("participant_left", {"sid": request.sid}, to=live["host_sid"])


@socketio.on("join_quiz")
def on_join_quiz(data):
    participant = joiners.get(request.sid)
    if not participant or not live["quiz"] or live["ended"]:
        return
    code = str(data.get("code", "")).strip().upper()
    if code != live["join_code"] or request.sid == live["host_sid"]:
        return
    name = str(data.get("name", "guest")).strip()[:40] or "guest"
    participant["name"] = name
    is_new = request.sid not in live["participants"]
    live["participants"].setdefault(
        request.sid, {"name": name, "score": 0, "online": True, "last_frame_at": 0}
    )
    live["participants"][request.sid]["online"] = True
    if is_new and live["host_sid"]:
        socketio.emit("participant_joined", {"sid": request.sid, "name": name}, to=live["host_sid"])
    socketio.emit("join_confirmed", {}, to=request.sid)


@socketio.on("participant_ready")
def on_participant_ready():
    sid = request.sid
    if not live["quiz"] or live["ended"] or sid not in live["participants"]:
        return
    live["participants"][sid]["ready"] = True
    if live["host_sid"]:
        socketio.emit("participant_ready", {"sid": sid}, to=live["host_sid"])


@socketio.on("participant_camera")
def on_participant_camera(data):
    sid = request.sid
    if (live["ended"] or not live["quiz"] or sid not in live["participants"]
            or not live["host_sid"]):
        return
    participant = live["participants"][sid]
    now = time.monotonic()
    if now - participant["last_frame_at"] < PREVIEW_INTERVAL_S:
        return
    frame = str(data.get("frame", ""))
    if not frame.startswith("data:image/jpeg;base64,") or len(frame) > 120_000:
        return
    socketio.emit("participant_camera", {
        "sid": sid,
        "name": participant["name"],
        "frame": frame,
    }, to=live["host_sid"])
    participant["last_frame_at"] = now


@socketio.on("submit_answer")
def on_submit_answer(data):
    """Record one answer per participant for the active question."""
    sid = request.sid
    if (live["quiz"] is None or not live["started"] or live["ended"]
            or sid not in live["participants"]):
        return
    choice = str(data.get("choice", "")).upper()
    item = live["quiz"]["questions"][live["index"]]
    if (choice not in item["choices"] or sid in live["answers"]
            or time.time() - live["question_started_at"] >= item["time_limit"]):
        return
    live["answers"][sid] = choice
    correct = choice == item["answer"]
    if correct:
        live["participants"][sid]["score"] += 1
    result = {"accepted": True, "selected_answer": choice}
    if live["quiz"].get("show_correct_answer"):
        result.update(correct=correct, correct_answer=item["answer"],
                      correct_text=item["choices"][item["answer"]])
    socketio.emit("answer_result", result, to=sid)
    if live["host_sid"]:
        socketio.emit("answer_locked", host_payload(), to=live["host_sid"])


@socketio.on("next_question")
def on_next_question():
    """Host advances after timeout, or closes the quiz after the final timeout."""
    if live["quiz"] is None or not live["started"] or live["ended"]:
        return
    item = live["quiz"]["questions"][live["index"]]
    if time.time() - live["question_started_at"] < item["time_limit"]:
        return
    if live["index"] + 1 >= len(live["quiz"]["questions"]):
        live["ended"] = True
        scoreboard = sorted(
            (dict(name=person["name"], score=person["score"])
             for person in live["participants"].values()),
            key=lambda person: (-person["score"], person["name"].casefold()),
        )
        live["scoreboard"] = scoreboard
        for sid, person in live["participants"].items():
            ticket = score_ticket_serializer.dumps({"quiz_id": live["quiz_id"], "sid": sid})
            socketio.emit("quiz_ended", {
                "score": person["score"],
                "scoreboard_url": url_for("participant_scoreboard_page", ticket=ticket),
            }, to=sid)
        if live["host_sid"]:
            socketio.emit("quiz_ended", {"scoreboard": scoreboard}, to=live["host_sid"])
        return
    live["index"] += 1
    live["locked_answer"] = None
    live["locked_name"] = None
    live["question_started_at"] = time.time()
    live["answers"] = {}
    reset_joiners()
    emit("question_update", host_payload(), broadcast=True)


@socketio.on("prepare_quiz")
def on_prepare_quiz(data):
    """Prepare a live quiz so participants can join before it starts."""
    quiz = database.get_quiz(int(data.get("quiz_id", 0)))
    if not quiz or not quiz["questions"]:
        return
    code = re.sub(r"[^A-Za-z0-9]", "", str(data.get("code", ""))).upper()[:12]
    if not code:
        return
    live.update(
        quiz_id=quiz["id"], quiz=quiz, index=0,
        locked_answer=None, locked_name=None,
        question_started_at=None, started=False,
        join_code=code,
        host_sid=request.sid,
        participants={},
        answers={},
        ended=False,
    )
    reset_joiners()


@socketio.on("start_quiz")
def on_start_quiz(data):
    if (live["quiz"] is None or live["ended"] or live["started"]
            or request.sid != live["host_sid"]
            or int(data.get("quiz_id", 0)) != live["quiz_id"]):
        return
    live["started"] = True
    live["question_started_at"] = time.time()
    emit("question_update", host_payload(), broadcast=True)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
database.init_db()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
