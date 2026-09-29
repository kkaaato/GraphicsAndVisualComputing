"""
vision.py — server-side OpenCV + MediaPipe hand-gesture pipeline
================================================================
Every camera frame from a joiner flows through this module:

    1. decode    base64 JPEG  -> cv2.imdecode
    2. resize    downscale to 640x480 (keeps the server cheap)
    3. preproc   grayscale + histogram equalization + Gaussian blur
    4. segment   YCrCb skin-color mask (inRange + morphology)
    5. detect    MediaPipe Hands on the RGB frame -> 21 landmarks
    6. interpret finger states -> answer choice + thumbs-up confirm
    7. annotate  cv2 lines/circles on the skeleton, mask overlay,
                 HUD text, corner insets showing the stages
    8. encode    cv2.imencode back to JPEG (base64) for the joiner

OpenCV does every image-processing step; MediaPipe contributes the
landmark model on top of the processed frames.
"""

import base64
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from urllib.request import urlretrieve

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

PROCESS_W, PROCESS_H = 640, 480
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_PATH = Path(tempfile.gettempdir()) / "gesturelock_hand_landmarker.task"

_CONNECTIONS = mp_vision.HandLandmarksConnections.HAND_CONNECTIONS
_hand_landmarker = None
_model_lock = threading.Lock()
_timestamp_lock = threading.Lock()
_last_timestamp_ms = 0


def get_hand_landmarker():
    """Create the Tasks detector and download its model once if needed."""
    global _hand_landmarker
    if _hand_landmarker is None:
        with _model_lock:
            if _hand_landmarker is None:
                model_path = Path(os.environ.get("HAND_LANDMARKER_MODEL", MODEL_PATH))
                if not model_path.is_file() or model_path.stat().st_size == 0:
                    model_path.parent.mkdir(parents=True, exist_ok=True)
                    download_path = model_path.with_suffix(model_path.suffix + ".download")
                    urlretrieve(MODEL_URL, download_path)
                    download_path.replace(model_path)
                options = mp_vision.HandLandmarkerOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
                    running_mode=mp_vision.RunningMode.VIDEO,
                    num_hands=2,
                    min_hand_detection_confidence=0.7,
                    min_hand_presence_confidence=0.7,
                    min_tracking_confidence=0.7,
                )
                _hand_landmarker = mp_vision.HandLandmarker.create_from_options(options)
    return _hand_landmarker


def next_timestamp_ms():
    """Return strictly increasing timestamps required by VIDEO mode."""
    global _last_timestamp_ms
    with _timestamp_lock:
        _last_timestamp_ms = max(time.monotonic_ns() // 1_000_000, _last_timestamp_ms + 1)
        return _last_timestamp_ms


# ---------------------------------------------------------------- stages 1-2
def decode_frame(data_url):
    """base64 data URL -> decoded, resized BGR image (stage 1 + 2)."""
    try:
        b64 = data_url.split(",", 1)[1]
        buf = np.frombuffer(base64.b64decode(b64), dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception:
        return None
    if frame is None:
        return None
    return cv2.resize(frame, (PROCESS_W, PROCESS_H))


# ---------------------------------------------------------------- stage 3
def preprocess(gray_in_bgr):
    """Normalization pipeline (stage 3): grayscale, histogram
    equalization (fights bad lighting), then Gaussian blur (denoise).
    Returns the grayscale result and a 3-channel copy for display."""
    gray = cv2.cvtColor(gray_in_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)                 # spread out brightness values
    gray = cv2.GaussianBlur(gray, (5, 5), 0)      # low-pass filter removes noise
    return gray, cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


# ---------------------------------------------------------------- stage 4
def skin_mask(frame):
    """Skin-color segmentation in the YCrCb color space (stage 4).
    inRange thresholds the chroma channels; morphology opens/closes
    the mask to remove specks and fill holes."""
    ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    mask = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)   # kill specks
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)  # fill holes
    return mask


# ---------------------------------------------------------------- stage 6
def finger_states(lm):
    """Which fingers are extended, from 21 landmarks.
    lm[i] has normalized .x/.y/.z attributes."""
    wrist = lm[0]

    def dist(a, b):
        return math.hypot(a.x - b.x, a.y - b.y)

    states = [dist(lm[4], wrist) > dist(lm[3], wrist) + 0.02]  # thumb: tip far from wrist
    for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18)):    # four fingers: tip above pip
        states.append(lm[tip].y < lm[pip].y - 0.02)
    return states


def choice_from(states):
    """1-4 extended fingers -> answer letter A-D."""
    if states[0]:
        return None
    count = sum(states[1:])
    return {1: "A", 2: "B", 3: "C", 4: "D"}.get(count)


def is_thumbs_up(states, lm):
    return states[0] and not any(states[1:]) and lm[4].y < lm[3].y - 0.02


# ---------------------------------------------------------------- stages 5-8
def process(data_url):
    """Run the full pipeline on one base64 JPEG frame.

    Returns (annotated_jpeg_data_url, (choice, confirmed)).
    choice: 'A'-'D' if a hand is pointing, confirmed: True if the
    other hand is showing a thumbs-up."""
    frame = decode_frame(data_url)
    if frame is None:
        return None, (None, False)

    gray, gray_bgr = preprocess(frame)
    mask = skin_mask(frame)

    # stage 5: landmark detection needs RGB input
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    rgb.flags.writeable = False
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    results = get_hand_landmarker().detect_for_video(image, next_timestamp_ms())

    h, w = frame.shape[:2]
    choice, confirmed = None, False

    if results.hand_landmarks:
        for landmarks in results.hand_landmarks:
            states = finger_states(landmarks)
            choice = choice_from(states) or choice
            if is_thumbs_up(states, landmarks):
                confirmed = True
            # stage 7a: skeleton
            for connection in _CONNECTIONS:
                pa, pb = landmarks[connection.start], landmarks[connection.end]
                cv2.line(frame,
                         (int(pa.x * w), int(pa.y * h)),
                         (int(pb.x * w), int(pb.y * h)),
                         (0, 255, 0), 2)
            for p in landmarks:
                cv2.circle(frame, (int(p.x * w), int(p.y * h)), 4, (0, 0, 255), -1)

    # stage 7b: show the skin segmentation as a translucent blue overlay
    overlay = frame.copy()
    overlay[mask > 0] = (255, 100, 0)
    frame = cv2.addWeighted(overlay, 0.25, frame, 0.75, 0)

    # stage 7c: HUD text + picture-in-picture insets of stages 3 and 4
    label = f"choice: {choice or '-'}" + ("  + THUMBS-UP" if confirmed else "")
    cv2.putText(frame, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    mask_bgr = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
    for i, (img, txt) in enumerate(((gray_bgr, "gray+eq+blur"), (mask_bgr, "skin mask"))):
        small = cv2.resize(img, (192, 144))
        x, y = 12, 40 + i * 164
        frame[y:y + 144, x:x + 192] = small
        cv2.rectangle(frame, (x, y), (x + 192, y + 144), (255, 255, 255), 1)
        cv2.putText(frame, txt, (x + 4, y + 138), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)

    # stage 8: re-encode for the browser
    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return None, (None, False)
    b64 = base64.b64encode(jpg.tobytes()).decode()
    return "data:image/jpeg;base64," + b64, (choice, confirmed)
