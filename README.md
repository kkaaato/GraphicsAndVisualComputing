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
  holding both steady for 0.8 s locks the answer.

## The browser vision pipeline (`static/join.js`)

1. `getUserMedia` — camera frames stay in the browser
2. MediaPipe Tasks `HandLandmarker` — detects 21 landmarks per hand
3. Finger-state math — extended fingers → answer letter; thumbs-up → confirm
4. Canvas rendering — draws the camera, choices, and gesture state
5. Socket.IO — sends only the confirmed answer to Flask

The participant view prompts users to move back when a detected hand fills too
much of the camera frame. Keep both hands visible, with the answering thumb
tucked and the confirming thumbs-up on the other hand.

The active quiz uses MediaPipe Tasks in the browser. `vision.py` is a separate
OpenCV/MediaPipe Tasks pipeline and is not called by the live quiz. It downloads
the hand-landmarker model on first use and caches it in the system temporary
folder; it requires an internet connection for that first run.

## Run locally in VS Code

1. Open the `GraphicsAndVisualComputing` folder in VS Code and select a Python
  3.11 interpreter.
2. In the integrated PowerShell terminal, create and install the environment:

  ```powershell
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
  ```

3. Start Flask from this folder:

  ```powershell
  .\.venv\Scripts\python.exe app.py
  ```

4. Open `http://127.0.0.1:5000` in a browser. Camera access works on localhost;
  do not open the HTML files directly. MediaPipe Tasks downloads its library
  and model from the internet when a participant joins.

## Privacy

Answers and display names are held in server memory for the live session only
and are never written to the database. During an active quiz, low-resolution
camera previews are sent to the host for live supervision; frames are relayed
in memory and are never recorded or stored. Gesture recognition runs locally
in the browser. Student joiners do not need accounts; account passwords are
stored hashed.

## Stack

Flask, Flask-SocketIO (threaded Gunicorn worker), MediaPipe Tasks (browser
hand-landmark model), SQLite.
