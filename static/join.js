const socket = io();

const COLORS = { A: "#ff6b57", B: "#2fb86e", C: "#ffc34b", D: "#8c6bff" };
const HOLD_MS = 1200;
const GRACE_MS = 350;      // a brief detection dropout won't reset the hold timer
const SMOOTH_FRAMES = 5;   // majority vote over the last N frames to remove flicker
const HOWTO_TEXT = "Pick an answer with 1–4 fingers on one hand, then give a thumbs-up with your other hand. Hold both for 1.2 seconds.";
const MP_VERSION = "0.10.14";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let displayName = null;
let currentQuestion = null;
let lockedAnswer = null;
let pointing = null;
let holdStart = null;
let quizEnded = false;
let lastPreviewAt = 0;
let timeLimit = 30;
let questionEndsAt = null;   // ms timestamp when the current question ends
let handsCount = 0;
let handsMissingSince = null;
let handWarning = "";
let lastVideoTime = -1;
let lastGoodAt = 0;
let lastChoice = null;
let lastConfirmed = false;
let detectedLabel = "";
const choiceVotes = [];
const confirmVotes = [];

function getTimeLeft() {
  return questionEndsAt ? Math.max(0, (questionEndsAt - Date.now()) / 1000) : null;
}
const previewCanvas = document.createElement("canvas");
previewCanvas.width = 320;
previewCanvas.height = 180;
const previewContext = previewCanvas.getContext("2d");
let joinCode = new URLSearchParams(window.location.search).get("code") ||
  document.getElementById("join-code").value.trim();

const video = document.createElement("video");
video.autoplay = true;
video.muted = true;
video.playsInline = true;

const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------- question state
async function refreshQuestion() {
  const query = joinCode ? `?code=${encodeURIComponent(joinCode)}` : "";
  const r = await fetch(`/api/question${query}`);
  if (r.status === 204) return;
  currentQuestion = await r.json();
    timeLimit = currentQuestion.time_limit || 30;
  const clockOffset = currentQuestion.server_time ? currentQuestion.server_time * 1000 - Date.now() : 0;
  const startedMs = currentQuestion.started_at ? currentQuestion.started_at * 1000 : Date.now() + clockOffset;
  questionEndsAt = startedMs + timeLimit * 1000 - clockOffset;
  if (displayName) {
    socket.emit("join_quiz", { code: joinCode, name: displayName });
  }
  lockedAnswer = null;
  pointing = null;
  holdStart = null;
  statusEl.textContent = HOWTO_TEXT;
  statusEl.className = "status";
  document.getElementById("question").textContent = currentQuestion.question;
}

socket.on("question_update", refreshQuestion);
socket.on("answer_result", (result) => {
  lockedAnswer = result.selected_answer;
  if (Object.hasOwn(result, "correct_answer")) {
    statusEl.textContent = result.correct
      ? `Correct! The answer is ${result.correct_answer}. ${result.correct_text}`
      : `Answer received. The correct answer is ${result.correct_answer}. ${result.correct_text}`;
    statusEl.className = result.correct ? "status correct" : "status wrong";
  } else {
    statusEl.textContent = "Answer received.";
    statusEl.className = "status";
  }
});
socket.on("quiz_ended", ({ scoreboard_url }) => {
  quizEnded = true;
  video.srcObject?.getTracks().forEach((track) => track.stop());
  window.location.assign(scoreboard_url);
});

// ---------------------------------------------------------------- gesture logic
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Compares landmark distances (not raw y values), so it works when the hand is
// tilted, rotated, or at a different distance from the camera.
function fingersUp(lm) {
  const wrist = lm[0];
  const palm = dist(lm[0], lm[9]) || 0.1;
  // thumb is "out" when its tip is clearly farther from the pinky base than its knuckle is
  const thumbOut =
    dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.15 && dist(lm[4], lm[5]) > palm * 0.45;
  const states = [thumbOut];
  for (const [tip, pip, mcp] of [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]]) {
    states.push(
      dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.12 &&
      dist(lm[tip], lm[mcp]) > palm * 0.55
    );
  }
  return states;
}

function choiceFrom(states) {
  const count = states.slice(1).filter(Boolean).length;
  const choice = { 1: "A", 2: "B", 3: "C", 4: "D" }[count];
  return choice && currentQuestion?.choices[choice] ? choice : null;
}

function isThumbsUp(states, lm) {
  if (!states[0] || states.slice(1).some(Boolean)) return false;
  const palm = dist(lm[0], lm[9]) || 0.1;
  const rise = lm[2].y - lm[4].y;          // > 0 when the thumb tip is above its base
  const sideways = Math.abs(lm[4].x - lm[2].x);
  return rise > palm * 0.4 && rise > sideways * 0.8;
}

// Most common value in the last few frames (latest wins ties).
function smooth(buffer, value) {
  buffer.push(value);
  if (buffer.length > SMOOTH_FRAMES) buffer.shift();
  const counts = new Map();
  let best = value;
  let bestCount = 0;
  for (const v of buffer) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c >= bestCount) { best = v; bestCount = c; }
  }
  return best;
}

// ---------------------------------------------------------------- camera loop
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

async function loadLandmarker() {
  const vision = await import(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`
  );
  const fileset = await vision.FilesetResolver.forVisionTasks(
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
  );
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await vision.HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    // some devices/browsers have no usable GPU delegate
    return vision.HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

function draw(now) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(video, 0, 0, w, h);

  if (!currentQuestion) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.max(28, Math.round(w * 0.035))}px sans-serif`;
    ctx.fillText("Waiting for the host to start…", Math.round(w * 0.02), Math.round(h * 0.07));
    return;
  }

  const letters = Object.keys(currentQuestion.choices);
  const boxH = Math.round(h * 0.09);
  const gap = 10;
  const y0 = h - (boxH + gap) * letters.length - gap;

  ctx.fillStyle = "rgba(20,20,20,0.85)";
  const headerHeight = Math.round(h * 0.12);
  ctx.fillRect(0, 0, w, headerHeight);
  ctx.fillStyle = "#ffffff";
  ctx.font = `${Math.max(28, Math.round(w * 0.038))}px sans-serif`;
  ctx.fillText(currentQuestion.question.slice(0, 72), Math.round(w * 0.02), Math.round(headerHeight * 0.68));
   // countdown: progress bar under the header + number badge
  const left = getTimeLeft();
  if (left !== null) {
    const frac = Math.min(left / timeLimit, 1);
    const urgent = left <= 5;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(0, headerHeight, w, 10);
    ctx.fillStyle = urgent ? "#f87171" : frac < 0.5 ? "#fbbf24" : "#4ade80";
    ctx.fillRect(0, headerHeight, w * frac, 10);
    const label = left > 0 ? `${Math.ceil(left)}s` : "Time's up";
    ctx.font = `bold ${Math.max(28, Math.round(w * 0.04))}px sans-serif`;
    const tw = ctx.measureText(label).width + 32;
    const th = Math.round(h * 0.09);
    ctx.fillStyle = urgent ? "#dc2626" : "rgba(20,20,20,0.85)";
    ctx.fillRect(w - tw - 14, headerHeight + 20, tw, th);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, w - tw + 2, headerHeight + 20 + th * 0.7);
  }

  if (detectedLabel) {
    ctx.font = `bold ${Math.max(20, Math.round(w * 0.024))}px sans-serif`;
    const dw = ctx.measureText(detectedLabel).width + 24;
    const dh = Math.round(h * 0.06);
    ctx.fillStyle = "rgba(20,20,20,0.75)";
    ctx.fillRect(14, headerHeight + 20, dw, dh);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(detectedLabel, 26, headerHeight + 20 + dh * 0.72);
  }

  letters.forEach((letter, i) => {
    const y = y0 + i * (boxH + gap);
    ctx.fillStyle = COLORS[letter];
    ctx.fillRect(14, y, w - 28, boxH);

    if (lockedAnswer === letter) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.strokeRect(14, y, w - 28, boxH);
    } else if (pointing === letter && holdStart) {
      const progress = Math.min((now - holdStart) / HOLD_MS, 1);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(14, y, (w - 28) * progress, boxH);
    }

    ctx.fillStyle = "#141414";
    ctx.font = `${Math.max(24, Math.round(w * 0.032))}px sans-serif`;
    ctx.fillText(`${letter}. ${currentQuestion.choices[letter]}`.slice(0, 58), Math.round(w * 0.025), y + boxH / 2 + Math.round(w * 0.01));
  });

  if (lockedAnswer) {
    ctx.fillStyle = "#2fb86e";
    ctx.font = `${Math.max(24, Math.round(w * 0.032))}px sans-serif`;
    ctx.fillText(`Locked in: ${lockedAnswer}`, Math.round(w * 0.02), h - Math.round(h * 0.01));
  }
  if (handWarning) {
    const bh = Math.round(h * 0.11);
    const by = Math.round(h * 0.42);
    ctx.fillStyle = "rgba(220, 38, 38, 0.88)";
    ctx.fillRect(0, by, w, bh);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(22, Math.round(w * 0.026))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`⚠ ${handWarning}`, w / 2, by + bh * 0.62);
    ctx.textAlign = "left";
  }
}

function track(landmarker) {
  if (quizEnded) return;
  const now = performance.now();
  if (video.readyState >= 2) {
    if (currentQuestion && Date.now() - lastPreviewAt >= 1000) {
      previewContext.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
      socket.emit("participant_camera", {
        frame: previewCanvas.toDataURL("image/jpeg", 0.4),
      });
      lastPreviewAt = Date.now();
    }
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, now);
      handsCount = result.landmarks.length;
      const picks = new Set();
      let thumbs = false;
      for (const lm of result.landmarks) {
        const states = fingersUp(lm);
        const pick = choiceFrom(states);
        if (pick) picks.add(pick);
        if (isThumbsUp(states, lm)) thumbs = true;
      }
      // two hands showing different letters is ambiguous, so ignore both
      lastChoice = smooth(choiceVotes, picks.size === 1 ? [...picks][0] : null);
      lastConfirmed = smooth(confirmVotes, thumbs);
    }
  }
  const choice = lastChoice;
  const confirmed = lastConfirmed;
 // warn only after ~1s so it doesn't flicker
  if (handsCount >= 2 || !currentQuestion || lockedAnswer) {
    handsMissingSince = null;
    handWarning = "";
  } else {
    handsMissingSince = handsMissingSince ?? now;
    if (now - handsMissingSince > 1000) {
      handWarning = handsCount === 0
        ? "No hands detected — show your hands to the camera"
        : "Only one hand visible — show both hands";
    }
  }
  if (currentQuestion && !lockedAnswer) {
    if (choice && confirmed) {
      lastGoodAt = now;
      if (choice !== pointing) {
        pointing = choice;
        holdStart = now;
      } else if (now - holdStart >= HOLD_MS) {
        lockedAnswer = choice;
        socket.emit("submit_answer", { choice, name: displayName });
      }
    } else if (now - lastGoodAt > GRACE_MS) {
      pointing = null;
      holdStart = null;
    }
  }
  detectedLabel = (!currentQuestion || lockedAnswer)
    ? ""
    : `Detected: ${choice ?? "–"} · thumbs-up ${confirmed ? "✓" : "✗"}`;

  draw(now);
  requestAnimationFrame(() => track(landmarker));
}

// ---------------------------------------------------------------- join flow
const dialog = document.getElementById("camera-dialog");
const joinStatus = document.getElementById("join-status");
const joinError = document.getElementById("join-error");
const joinButton = document.getElementById("start-btn");

// Step 1: validate the form, then ask the person to confirm before touching the camera.
joinButton.addEventListener("click", () => {
  const code = document.getElementById("join-code").value.trim();
  displayName = document.getElementById("display-name").value.trim();
  if (!code || !displayName) {
    joinError.style.display = "block";
    joinError.textContent = "Enter the quiz code and your display name.";
    return;
  }
  joinError.style.display = "none";
  joinCode = code;
  dialog.showModal();
});
document.getElementById("camera-cancel").addEventListener("click", () => dialog.close());
document.getElementById("camera-confirm").addEventListener("click", () => {
  dialog.close();
  joinQuiz();
});

// Step 2: after confirmation, start the camera and join.
async function joinQuiz() {
  joinButton.disabled = true;
  joinError.style.display = "none";
  joinStatus.hidden = false;
  joinStatus.textContent = "Waiting for camera permission…";
  try {
    await startCamera();
    joinStatus.textContent = "Loading hand detection… this can take a few seconds.";
    const landmarker = await loadLandmarker();
    socket.emit("join_quiz", { code: joinCode, name: displayName });
    document.getElementById("join-form").style.display = "none";
    document.getElementById("quiz-view").style.display = "block";
    await refreshQuestion();
    requestAnimationFrame(() => track(landmarker));
  } catch (e) {
    video.srcObject?.getTracks().forEach((track) => track.stop());
    joinError.style.display = "block";
    joinError.textContent =
      e.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser and try again."
      : e.name === "NotFoundError" ? "No camera was found on this device."
      : e.name === "NotReadableError" ? "Your camera is in use by another app. Close it and try again."
      : `Could not start: ${e.message}`;
  } finally {
    joinStatus.hidden = true;
    joinButton.disabled = false;
  }
}

document.getElementById("leave-btn").addEventListener("click", () => {
  if (!window.confirm("Leave this quiz?")) return;
  quizEnded = true;
  video.srcObject?.getTracks().forEach((track) => track.stop());
  socket.disconnect();
  window.location.assign("/");
});

refreshQuestion();
