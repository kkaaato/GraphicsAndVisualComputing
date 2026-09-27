"""
Gesture Quiz — Student Client (OpenCV camera tracking)
=========================================================
Run this on the STUDENT's own device. It opens their webcam,
tracks hand gestures with OpenCV + MediaPipe (same logic as the
original prototype), and draws the current question and answer
choices directly onto the camera window — no browser needed here.

Gesture scheme:
  1-4 fingers on one hand      = pick A-D
  thumbs-up on the other hand  = confirm
  hold both steady for ~1.2s to lock in the answer

SETUP
-----
pip install -r requirements_client.txt

RUN
---
python student_client.py --server http://<server-ip>:5000
"""

import argparse
import os
import time
import threading
import urllib.request

import cv2
import numpy as np
import mediapipe as mp
import requests
import socketio
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")
CAM_INDEX = 0
MIN_CONF = 0.7
HOLD_SECONDS = 1.2
CHOICE_COLORS = {  # BGR
    "A": (87, 107, 255),
    "B": (172, 184, 47),
    "C": (75, 198, 255),
    "D": (255, 107, 140),
}


def download_model_if_missing():
    if os.path.exists(MODEL_PATH):
        return
    print("Downloading hand landmarker model...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


def fingers_up(lm, w, h):
    def pt(i):
        return np.array([lm[i].x * w, lm[i].y * h])

    wrist = pt(0)
    states = [np.linalg.norm(pt(4) - wrist) > np.linalg.norm(pt(3) - wrist) + 8]
    for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18)):
        states.append(pt(tip)[1] < pt(pip)[1] - 8)
    return states


def gesture_to_choice(states):
    count = sum(states[1:])
    return {1: "A", 2: "B", 3: "C", 4: "D"}.get(count)


def is_thumbs_up(states, lm, h):
    thumb_is_up = lm[4].y * h < lm[3].y * h - 8
    return states[0] and not any(states[1:]) and thumb_is_up


class QuizState:
    def __init__(self, server_url):
        self.server_url = server_url.rstrip("/")
        self.question = None
        self.locked_answer = None
        self.lock = threading.Lock()

    def fetch_question(self):
        try:
            r = requests.get(f"{self.server_url}/api/question", timeout=3)
            data = r.json()
        except requests.RequestException:
            return
        with self.lock:
            if self.question is None or data["index"] != self.question.get("index"):
                self.locked_answer = None
            self.question = data


def draw_quiz_overlay(frame, q, pointing, hold_start, locked_answer):
    h, w = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (w, 60), (20, 20, 20), -1)
    cv2.putText(frame, q["question"][:70], (16, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)

    box_h = 55
    gap = 8
    letters = [l for l in ("A", "B", "C", "D") if q["choices"].get(l)]
    y0 = h - (box_h + gap) * len(letters) - gap
    now = time.time()

    for i, letter in enumerate(letters):
        text = q["choices"][letter]
        y = y0 + i * (box_h + gap)
        color = CHOICE_COLORS[letter]
        cv2.rectangle(frame, (16, y), (w - 16, y + box_h), color, -1)

        if locked_answer == letter:
            cv2.rectangle(frame, (16, y), (w - 16, y + box_h), (255, 255, 255), 4)
        elif pointing == letter and hold_start:
            progress = min((now - hold_start) / HOLD_SECONDS, 1.0)
            fill_w = int((w - 32) * progress)
            cv2.rectangle(frame, (16, y), (16 + fill_w, y + box_h), (255, 255, 255), -1)
            cv2.rectangle(frame, (16, y), (w - 16, y + box_h), color, 2)

        cv2.putText(frame, f"{letter}. {text}"[:50], (28, y + 36),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (20, 20, 20), 2)

    if locked_answer:
        cv2.putText(frame, f"Locked in: {locked_answer}", (16, h - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True, help="e.g. http://192.168.1.23:5000")
    args = parser.parse_args()

    download_model_if_missing()
    quiz = QuizState(args.server)
    quiz.fetch_question()

    sio = socketio.Client()

    @sio.on("question_update")
    def on_question_update(data):
        with quiz.lock:
            quiz.question = data
            quiz.locked_answer = None

    @sio.on("connect")
    def on_connect():
        print("Connected to server:", args.server)

    sio.connect(args.server)

    cap = cv2.VideoCapture(CAM_INDEX)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720

    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
        num_hands=2,
        min_hand_detection_confidence=MIN_CONF,
        min_hand_presence_confidence=MIN_CONF,
        min_tracking_confidence=MIN_CONF,
    )
    landmarker = vision.HandLandmarker.create_from_options(options)

    pointing, hold_start = None, None
    print("Press 'q' to quit.")

    while True:
        ok, frame = cap.read()
        if not ok:
            continue
        frame = cv2.flip(frame, 1)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(mp_image)

        choice, confirmed = None, False
        for lm in result.hand_landmarks:
            if len(lm) < 21:
                continue
            states = fingers_up(lm, w, h)
            hand_choice = gesture_to_choice(states)
            if hand_choice is not None:
                choice = hand_choice
            elif is_thumbs_up(states, lm, h):
                confirmed = True
            for p in lm:
                x, y = int(p.x * w), int(p.y * h)
                cv2.circle(frame, (x, y), 3, (0, 255, 255), -1)

        with quiz.lock:
            q = quiz.question
            already_locked = quiz.locked_answer

        if q and already_locked is None:
            now = time.time()
            if choice and confirmed:
                if choice != pointing:
                    pointing, hold_start = choice, now
                if now - hold_start >= HOLD_SECONDS:
                    with quiz.lock:
                        quiz.locked_answer = choice
                    sio.emit("submit_answer", {"choice": choice})
            else:
                pointing, hold_start = None, None
        elif already_locked is not None:
            pointing, hold_start = None, None

        if q:
            draw_quiz_overlay(frame, q, pointing, hold_start, already_locked)
        else:
            cv2.putText(frame, "Waiting for quiz to start...", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            quiz.fetch_question()

        cv2.imshow("Gesture Quiz - Student", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    sio.disconnect()


if __name__ == "__main__":
    main()
