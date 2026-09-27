# GestureLock

A multiple-choice quiz system with dual-hand gesture confirmation for virtual
classroom assessments. Teachers host quizzes from a browser; students join from
a browser on any device — no installs.

## How it works

- **Host** — creates an account, builds a quiz (one question per line:
  `question|choiceA|choiceB|choiceC|choiceD|correctLetter`), and opens the
  Host page to advance questions.
- **Join** — students open `/join`, enter a display name, and allow the
  camera. 1–4 fingers on one hand pick A–D, a thumbs-up on the other hand
  confirms; holding both steady for 1.2s locks the answer.

## Privacy

Hand tracking runs entirely in the joiner's browser. Camera frames are
processed in device memory and are never transmitted, recorded, or stored.
The only data sent to the server is the locked answer letter and the display
name, which are held in server memory for the live session only and are never
written to the database. Student joiners do not need accounts.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Web Service → select the repo.
3. If `render.yaml` is detected, settings are filled in automatically.
   Otherwise: build command `pip install -r requirements.txt`,
   start command `gunicorn --worker-class eventlet -w 1 app:app`.
4. Add a `SECRET_KEY` environment variable (Render can generate one).
5. Host logs in at `https://<your-app>.onrender.com`, creates a quiz, opens
   its Host page; students join at `https://<your-app>.onrender.com/join`.

Notes: the free tier sleeps after inactivity — wake the site before a
session. The SQLite file is ephemeral on Render; create quizzes after
deploying. Camera access requires HTTPS, which Render provides.

## Stack

Flask, Flask-SocketIO (eventlet + gunicorn, single worker), SQLite,
MediaPipe HandLandmarker in the browser via CDN, OpenCV-free joiner.
