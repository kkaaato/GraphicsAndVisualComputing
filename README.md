# GestureLock

A multiple-choice quiz system with dual-hand gesture confirmation for virtual
classroom assessments. Teachers host quizzes from a browser; students join from
a browser on any device — no installs.

## How it works

- **Host** — creates an account, builds a quiz (one question per line:
  `question|choiceA|choiceB|choiceC|choiceD|correctLetter`), and opens the
  Host page to advance questions.
- **Join** — students open `/join`, enter a display name, and allow the
  camera. Camera frames stream to the server (~7 fps at 640×480), where an
  OpenCV pipeline processes them: grayscale + histogram equalization +
  Gaussian blur, YCrCb skin segmentation, then MediaPipe hand landmarks.
  1–4 fingers on one hand pick A–D, a thumbs-up on the other hand confirms;
  holding both steady for 1.2 s locks the answer.

## The vision pipeline (`vision.py`)

1. `cv2.imdecode` — base64 JPEG from the browser becomes an image
2. `cv2.resize` — downscale to 640×480
3. `cv2.cvtColor` → `cv2.equalizeHist` → `cv2.GaussianBlur` — normalize lighting, denoise
4. `cv2.inRange` in YCrCb + `cv2.morphologyEx` — skin-color segmentation
5. MediaPipe Hands — 21 landmarks per hand (the ML model, built on OpenCV)
6. Finger-state math — extended fingers → answer letter; thumbs-up → confirm
7. `cv2.line` / `cv2.circle` / `cv2.putText` — annotated frame back to the joiner
8. `cv2.imencode` — re-encode to JPEG

## Privacy

Answers and display names are held in server memory for the live session only
and are never written to the database. Camera frames are processed in memory
per frame and are never recorded or stored; they exist only as transient
in-flight data between the joiner and the server. Student joiners do not need
accounts; account passwords are stored hashed.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Web Service → select the repo.
3. If `render.yaml` is detected, settings are filled in automatically
   (including `PYTHON_VERSION=3.11`, required by MediaPipe).
   Otherwise: build command `pip install -r requirements.txt`,
   start command `gunicorn --worker-class eventlet -w 1 app:app`.
4. Add a `SECRET_KEY` environment variable (Render can generate one).
5. Host logs in at `https://<your-app>.onrender.com`, creates a quiz, opens
   its Host page; students join at `https://<your-app>.onrender.com/join`.

Notes: the free tier sleeps after inactivity — wake the site before a
session, and expect more latency than a local run since frames are processed
on the server. The SQLite file is ephemeral on Render; create quizzes after
deploying. Camera access requires HTTPS, which Render provides.

## Stack

Flask, Flask-SocketIO (eventlet + gunicorn, single worker), OpenCV (server-side
frame pipeline), MediaPipe Hands (landmark model), SQLite.
