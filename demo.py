"""
Fingertip Tracking Demo
=========================================================
Draw in the air with your index finger using your webcam.
Uses the MediaPipe TASKS API (HandLandmarker) — required for MediaPipe >= 0.10.30.

SETUP (one time)
----------------
1. pip install opencv-python mediapipe numpy
2. Download the hand landmarker model and put it in THIS folder:
   https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

GESTURE COMMANDS
----------------
  INDEX finger only ............. DRAW
  OPEN PALM (all fingers up) .... PAUSE (stop drawing)
    FIST .......................... PAUSE (stop drawing)

KEYBOARD
--------
    q / ESC : quit     DELETE / CTRL+Z : undo     CTRL+Y : redo     s : save screenshot
"""

import os
import time
import urllib.request

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")


def download_model_if_missing():
    if os.path.exists(MODEL_PATH):
        return
    print(f"Downloading MediaPipe hand model to: {MODEL_PATH}")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

# ----------------------------- CONFIG --------------------------------------
CAM_INDEX          = 0
MIN_CONF           = 0.7
SMOOTH_ALPHA       = 0.65     # EMA smoothing for fingertip (0-1, higher = snappier)
PINCH_DIST_PX      = 35       # thumb-index distance (pixels) that counts as a pinch
DRAW_COLOR         = (255, 255, 255)  # fixed white pen for now
BG_COLOR           = (25, 25, 25)                   # canvas background (BGR)

# --------------------------- HELPERS ---------------------------------------
def fingers_up(lm, w, h):
    """Return [thumb, index, middle, ring, pinky] booleans (True = extended)."""
    def pt(i):
        return np.array([lm[i].x * w, lm[i].y * h])

    wrist = pt(0)
    states = []
    # Thumb: compare tip-to-wrist vs ip-to-wrist distance
    states.append(np.linalg.norm(pt(4) - wrist) > np.linalg.norm(pt(3) - wrist) + 8)
    # Other fingers: tip above PIP joint (image y grows downward)
    for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18)):
        states.append(pt(tip)[1] < pt(pip)[1] - 8)
    return states

def classify_gesture(states):
    """Map finger states to a command."""
    thumb, index, middle, ring, pinky = states
    if not any(states):
        return "FIST"
    if index and middle and ring and pinky:
        return "OPEN_PALM"
    if index and not middle and not ring and not pinky:
        return "DRAW"
    return "IDLE"


HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
]


def draw_hand_landmarks(frame, lm, w, h):
    """Render the detected hand skeleton so each tracked part is visible."""
    pts = [(int(lm[i].x * w), int(lm[i].y * h)) for i in range(len(lm))]

    for a, b in HAND_CONNECTIONS:
        if 0 <= a < len(pts) and 0 <= b < len(pts):
            cv2.line(frame, pts[a], pts[b], (180, 220, 255), 2)

    highlight = {
        0: (255, 255, 255),
        4: (255, 150, 100),
        8: (0, 255, 255),
        12: (0, 255, 0),
        16: (255, 0, 255),
        20: (255, 255, 0),
    }

    for i, (x, y) in enumerate(pts):
        color = highlight.get(i, (180, 180, 180))
        radius = 6 if i in highlight else 3
        cv2.circle(frame, (x, y), radius, color, -1)

        if i in highlight:
            label = ["Wrist", "Thumb", "Index", "Middle", "Ring", "Pinky"]
            if i == 0:
                text = "Wrist"
            elif i == 4:
                text = "Thumb"
            elif i == 8:
                text = "Index"
            elif i == 12:
                text = "Middle"
            elif i == 16:
                text = "Ring"
            elif i == 20:
                text = "Pinky"
            else:
                text = str(i)
            cv2.putText(frame, text, (x + 8, y - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)

# ------------------------------ MAIN ---------------------------------------
def main():
    download_model_if_missing()

    cap = cv2.VideoCapture(CAM_INDEX)
    if not cap.isOpened():
        raise RuntimeError("Could not open webcam.")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720

    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
        num_hands=1,
        min_hand_detection_confidence=MIN_CONF,
        min_hand_presence_confidence=MIN_CONF,
        min_tracking_confidence=MIN_CONF,
    )
    landmarker = vision.HandLandmarker.create_from_options(options)

    canvas = np.full((h, w, 3), BG_COLOR, dtype=np.uint8)

    color = DRAW_COLOR
    smooth_pt = None
    prev_pt = None
    prev_gesture = None
    undo_stack = [canvas.copy()]
    redo_stack = []
    flash_msg, flash_until = "", 0.0

    def flash(text):
        nonlocal flash_msg, flash_until
        flash_msg, flash_until = text, time.time() + 1.2

    def undo():
        nonlocal canvas
        if len(undo_stack) <= 1:
            flash("NOTHING TO UNDO")
            return
        redo_stack.append(canvas.copy())
        undo_stack.pop()
        canvas = undo_stack[-1].copy()
        flash("UNDO")

    def redo():
        nonlocal canvas
        if not redo_stack:
            flash("NOTHING TO REDO")
            return
        canvas = redo_stack.pop()
        undo_stack.append(canvas.copy())
        flash("REDO")

    prev_time = time.time()
    window_name = "Drawing Demo"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.setWindowProperty(window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    print("Drawing Demo running. Press 'q' to quit. Press 'f' to toggle fullscreen.")

    fullscreen = True
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.flip(frame, 1)                      # mirror view
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(mp_image)

        gesture = "NO_HAND"
        cursor  = None

        if result.hand_landmarks:
            lm = result.hand_landmarks[0]
            if len(lm) >= 21:
                draw_hand_landmarks(frame, lm, w, h)
                states = fingers_up(lm, w, h)
                gesture = classify_gesture(states)
                tip = np.array([lm[8].x * w, lm[8].y * h])
            else:
                gesture = "IDLE"
                tip = np.array([w // 2, h // 2])

            if gesture == "FIST":
                smooth_pt, prev_pt = None, None

            elif gesture == "DRAW":
                if prev_gesture != "DRAW":
                    undo_stack.append(canvas.copy())
                    redo_stack.clear()
                if smooth_pt is None:
                    smooth_pt = tip
                else:
                    smooth_pt = SMOOTH_ALPHA * tip + (1 - SMOOTH_ALPHA) * smooth_pt
                pt = tuple(smooth_pt.astype(int))
                thick = 6
                if prev_pt is not None:
                    cv2.line(canvas, prev_pt, pt, color, thick, cv2.LINE_AA)
                else:
                    cv2.circle(canvas, pt, thick // 2, color, -1, cv2.LINE_AA)
                prev_pt = pt

            elif gesture == "OPEN_PALM":
                smooth_pt, prev_pt = None, None

        else:
            smooth_pt, prev_pt = None, None

        prev_gesture = gesture

        # ---- overlay canvas + UI ----
        pen_mask = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY) > 10
        frame[pen_mask] = cv2.addWeighted(frame, 0.35, canvas, 0.65, 0)[pen_mask]

        # legend / command panel
        panel = frame.copy()
        cv2.rectangle(panel, (8, 8), (330, 158), (0, 0, 0), -1)
        cv2.addWeighted(panel, 0.55, frame, 0.45, 0, frame)
        cv2.rectangle(frame, (8, 8), (330, 158), (120, 120, 120), 1)

        mode_color = {"DRAW": (60, 220, 60), "OPEN_PALM": (60, 160, 255),
                  "FIST": (150, 150, 150),
                      "IDLE": (150, 150, 150), "NO_HAND": (150, 150, 150)}
        mc = mode_color.get(gesture, (150, 150, 150))
        cv2.circle(frame, (24, 30), 7, mc, -1)
        cv2.putText(frame, f"MODE: {gesture}", (38, 35),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, mc, 2)

        legend = [
            ("INDEX ONLY ......... DRAW", "DRAW"),
            ("OPEN PALM .......... PAUSE", "OPEN_PALM"),
            ("FIST ............... PAUSE", "FIST"),
        ]
        for i, (txt, g) in enumerate(legend):
            col = mode_color[g] if gesture == g else (200, 200, 200)
            cv2.putText(frame, txt, (18, 62 + i * 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, col, 1)

        # flash message / cursor / FPS
        if time.time() < flash_until:
            cv2.putText(frame, flash_msg, (w // 2 - 120, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (60, 255, 60), 2)
        if cursor is not None:
            cv2.circle(frame, cursor, 10, (255, 255, 255), 2)
            cv2.circle(frame, cursor, 2, (255, 255, 255), -1)

        now = time.time()
        fps = 1.0 / max(now - prev_time, 1e-6)
        prev_time = now
        cv2.putText(frame, f"FPS: {fps:.0f}", (w - 110, h - 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 1)

        cv2.imshow(window_name, frame)
        key = cv2.waitKeyEx(1)
        key_low = key & 0xFF
        if key_low in (27, ord('q')):
            break
        if key_low == ord('f'):
            fullscreen = not fullscreen
            cv2.setWindowProperty(window_name,
                                  cv2.WND_PROP_FULLSCREEN,
                                  cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)
        if key != -1 and (key_low in (255, 127) or key in (3014656,)):
            undo()
        if key_low == 26:
            undo()
        if key_low == 25:
            redo()
        if key_low == ord('s'):
            cv2.imwrite(f"visionwrite_{int(now)}.png", frame)
            flash("SCREENSHOT SAVED")

    cap.release()
    cv2.destroyAllWindows()
    landmarker.close()

if __name__ == "__main__":
    main()