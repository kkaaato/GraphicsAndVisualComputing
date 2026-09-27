# GestureLock

A multiple-choice quiz system with dual-hand gesture confirmation for virtual
classroom assessments. Account holders host quizzes from a browser; students join from
a browser on any device — no installs.

## How it works

- **Host** — creates an account, builds a quiz (one question per line:
  `question|choiceA|choiceB|choiceC|choiceD|correctLetter`), and opens the
  Host page to advance questions.
- **Join** — students open `/join`, enter a display name, and allow the
  camera. MediaPipe Tasks processes the camera locally in the browser, and
  only the confirmed answer is sent to the server.
  1–4 fingers on one hand pick A–D, a thumbs-up on the other hand confirms;
  holding both steady for 1.2 s locks the answer.

## The browser vision pipeline (`static/join.js`)

1. `getUserMedia` — camera frames stay in the browser
2. MediaPipe Tasks `HandLandmarker` — detects 21 landmarks per hand
3. Finger-state math — extended fingers → answer letter; thumbs-up → confirm
4. Canvas rendering — draws the camera, choices, and gesture state
5. Socket.IO — sends only the confirmed answer to Flask

## Privacy

Answers and display names are held in server memory for the live session only
and are never written to the database. Camera frames are processed locally in
the browser and are never sent to or stored by the server. Student joiners do
not need accounts; account passwords are stored hashed.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Web Service → select the repo.
3. If `render.yaml` is detected, settings are filled in automatically
  (including `PYTHON_VERSION=3.11`).
   Otherwise: build command `pip install -r requirements.txt`,
  start command `gunicorn --worker-class gthread --threads 100 --workers 1 app:app`.
4. Add a `SECRET_KEY` environment variable (Render can generate one).
5. Host logs in at `https://<your-app>.onrender.com`, creates a quiz, opens
   its Host page; students join at `https://<your-app>.onrender.com/join`.

Notes: the free tier sleeps after inactivity — wake the site before a
session. The SQLite file is ephemeral on Render; create quizzes after
deploying. Camera access requires HTTPS, which Render provides.

## Stack

Flask, Flask-SocketIO (threaded Gunicorn worker), MediaPipe Tasks (browser
hand-landmark model), SQLite.
