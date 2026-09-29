const socket = io();

const COLORS = { A: "#ff6b57", B: "#6fcf4a", C: "#ffd23f", D: "#5fb0f0" };
const HOLD_MS = 800;
const NO_HAND_WARNING_MS = 900; // how long with no hand before we show the toast
const PREVIEW_INTERVAL_MS = 200;
const HAND_TOO_CLOSE_RATIO = 0.55;
const MP_VERSION = "0.10.14";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let displayName = null;
let currentQuestion = null;
let lockedAnswer = null;
let pointing = null;
let holdStart = null;
let quizEnded = false;
let lastPreviewAt = 0;
let lastHandSeenAt = performance.now();
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
const DEFAULT_HINT = statusEl.textContent;

// ---------------------------------------------------------------- question state
async function refreshQuestion() {
  const query = joinCode ? `?code=${encodeURIComponent(joinCode)}` : "";
  const r = await fetch(`/api/question${query}`);
  if (r.status === 204) return;
  currentQuestion = await r.json();
  if (displayName) {
    socket.emit("join_quiz", { code: joinCode, name: displayName });
  }
  document.getElementById("ready-btn").hidden = true;
  lockedAnswer = null;
  pointing = null;
  holdStart = null;
  statusEl.className = "status";
  statusEl.textContent = DEFAULT_HINT;
  document.getElementById("question").textContent = currentQuestion.question;
}

socket.on("question_update", refreshQuestion);
socket.on("join_confirmed", () => {
  if (!currentQuestion) {
    document.getElementById("ready-btn").hidden = false;
    statusEl.textContent = "You're in. Let the host know when you're ready.";
  }
});
socket.on("answer_result", (result) => {
  lockedAnswer = result.selected_answer;
  if (Object.hasOwn(result, "correct_answer")) {
    statusEl.textContent = result.correct
      ? `Correct! The answer is ${result.correct_answer}. ${result.correct_text}`
      : `Answer received. The correct answer is ${result.correct_answer}. ${result.correct_text}`;
    statusEl.className = result.correct ? "status result-banner correct" : "status result-banner wrong";
  } else {
    statusEl.textContent = `\u2713 Answer locked in: ${result.selected_answer}`;
    statusEl.className = "status result-banner locked";
  }
});
socket.on("quiz_ended", ({ scoreboard_url }) => {
  quizEnded = true;
  video.srcObject?.getTracks().forEach((track) => track.stop());
  window.location.assign(scoreboard_url);
});

// ---------------------------------------------------------------- gesture logic
function fingersUp(lm) {
  const wrist = lm[0];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const states = [dist(lm[4], wrist) > dist(lm[3], wrist) + 0.02];
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    states.push(lm[tip].y < lm[pip].y - 0.02);
  }
  return states;
}

function choiceFrom(states) {
  if (states[0]) return null;
  const count = states.slice(1).filter(Boolean).length;
  const choice = { 1: "A", 2: "B", 3: "C", 4: "D" }[count];
  return choice && currentQuestion?.choices[choice] ? choice : null;
}

function isThumbsUp(states, lm) {
  return states[0] && !states.slice(1).some(Boolean) && lm[4].y < lm[3].y - 0.02;
}

function isHandTooClose(lm) {
  const xs = lm.map((point) => point.x);
  const ys = lm.map((point) => point.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    > HAND_TOO_CLOSE_RATIO;
}

// ---------------------------------------------------------------- camera loop
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720 },
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
  const createOptions = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.7,
    minHandPresenceConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });
  try {
    return await vision.HandLandmarker.createFromOptions(fileset, createOptions("GPU"));
  } catch {
    return vision.HandLandmarker.createFromOptions(fileset, createOptions("CPU"));
  }
}

function drawTimerChip(w, remainingSeconds, color) {
  const label = remainingSeconds == null ? "" : `0:${String(Math.max(0, remainingSeconds)).padStart(2, "0")}`;
  if (!label) return;
  const chipW = Math.round(w * 0.11);
  const chipH = Math.round(w * 0.034);
  const x = w - chipW - 14;
  const y = 12;
  ctx.fillStyle = "rgba(20,34,75,0.88)";
  ctx.beginPath();
  ctx.roundRect(x, y, chipW, chipH, chipH / 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + chipH * 0.55, y + chipH / 2, chipH * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `${Math.round(chipH * 0.5)}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + chipH * 0.95, y + chipH / 2 + 1);
  ctx.textBaseline = "alphabetic";
}

function drawHoldRing(w, h, progress, letter) {
  const r = Math.round(w * 0.032);
  const cx = w / 2;
  const cy = h - r - 16;
  ctx.lineWidth = Math.max(3, Math.round(r * 0.22));
  ctx.strokeStyle = "rgba(212,240,74,0.3)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#d4f04a";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.font = `700 ${Math.round(r * 0.9)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#14224b";
  ctx.lineWidth = Math.max(2, Math.round(r * 0.12));
  ctx.strokeText(letter, cx, cy + 1);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(letter, cx, cy + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawCameraToast(w, h, label) {
  ctx.font = `${Math.max(16, Math.round(w * 0.022))}px sans-serif`;
  const textW = ctx.measureText(label).width;
  const padX = 16;
  const boxW = textW + padX * 2 + 24;
  const boxH = Math.round(w * 0.045);
  const x = w / 2 - boxW / 2;
  const y = h - boxH - 16;
  ctx.fillStyle = "rgba(255,228,224,0.96)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.strokeStyle = "#d8322a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, boxH / 2);
  ctx.stroke();
  ctx.fillStyle = "#d8322a";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + boxW / 2 - textW / 2, y + boxH / 2 + 1);
  ctx.textBaseline = "alphabetic";
}

function drawLockedBanner(w, h, letter) {
  const label = `\u2713  ANSWER LOCKED IN: ${letter}`;
  const fontSize = Math.max(28, Math.round(w * 0.04));
  ctx.font = `800 ${fontSize}px sans-serif`;
  const textW = ctx.measureText(label).width;
  const boxW = textW + fontSize * 1.6;
  const boxH = Math.round(fontSize * 1.9);
  const x = w / 2 - boxW / 2;
  const y = h * 0.4 - boxH / 2;
  ctx.fillStyle = "rgba(212,240,74,0.97)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.strokeStyle = "#14224b";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "#14224b";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h * 0.4 + 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function draw(now, remainingSeconds, noHand, handTooClose) {
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

  const timerColor = remainingSeconds != null && remainingSeconds <= 5 ? "#d8322a" : "#d4f04a";
  drawTimerChip(w, remainingSeconds, timerColor);

  letters.forEach((letter, i) => {
    const y = y0 + i * (boxH + gap);
    ctx.globalAlpha = lockedAnswer && lockedAnswer !== letter ? 0.35 : 1;
    ctx.fillStyle = COLORS[letter];
    ctx.fillRect(14, y, w - 28, boxH);

    if (lockedAnswer === letter) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 8;
      ctx.strokeRect(18, y + 4, w - 36, boxH - 8);
    }

    ctx.fillStyle = "#14224b";
    ctx.font = `${Math.max(24, Math.round(w * 0.032))}px sans-serif`;
    ctx.fillText(`${letter}. ${currentQuestion.choices[letter]}`.slice(0, 58), Math.round(w * 0.025), y + boxH / 2 + Math.round(w * 0.01));
    ctx.globalAlpha = 1;
  });

  if (lockedAnswer) {
    drawLockedBanner(w, h, lockedAnswer);
  } else if (handTooClose) {
    drawCameraToast(w, h, "Move back so both hands fit in view");
  } else if (pointing && holdStart) {
    drawHoldRing(w, h, Math.min((now - holdStart) / HOLD_MS, 1), pointing);
  } else if (noHand) {
    drawCameraToast(w, h, "Show both hands clearly");
  }
}

function track(landmarker) {
  if (quizEnded) return;
  const now = performance.now();
  let choice = null;
  let confirmed = false;
  let sawAnyHand = false;
  let handTooClose = false;

  if (video.readyState >= 2) {
    if (currentQuestion && Date.now() - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
      previewContext.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
      socket.emit("participant_camera", {
        frame: previewCanvas.toDataURL("image/jpeg", 0.4),
      });
      lastPreviewAt = Date.now();
    }
    const result = landmarker.detectForVideo(video, now);
    sawAnyHand = result.landmarks.length > 0;
    for (const lm of result.landmarks) {
      handTooClose = handTooClose || isHandTooClose(lm);
      const states = fingersUp(lm);
      choice = choiceFrom(states) || choice;
      if (isThumbsUp(states, lm)) confirmed = true;
    }
  }

  if (sawAnyHand) lastHandSeenAt = now;
  const noHand = !lockedAnswer && currentQuestion && (now - lastHandSeenAt) > NO_HAND_WARNING_MS;

  if (currentQuestion && !lockedAnswer && !handTooClose) {
    if (choice && confirmed) {
      if (choice !== pointing) {
        pointing = choice;
        holdStart = now;
      } else if (now - holdStart >= HOLD_MS) {
        lockedAnswer = choice;
        socket.emit("submit_answer", { choice, name: displayName });
      }
    } else {
      pointing = null;
      holdStart = null;
    }
  } else if (handTooClose && !lockedAnswer) {
    pointing = null;
    holdStart = null;
  }

  let remainingSeconds = null;
  if (currentQuestion?.started_at && currentQuestion?.time_limit) {
    remainingSeconds = Math.max(0, Math.ceil(
      currentQuestion.time_limit - (Date.now() / 1000 - currentQuestion.started_at)
    ));
  }

  draw(now, remainingSeconds, noHand, handTooClose);
  requestAnimationFrame(() => track(landmarker));
}

// ---------------------------------------------------------------- join flow
function showCameraToast(message, isError) {
  const toast = document.getElementById("camera-toast");
  toast.textContent = message;
  toast.className = `camera-toast show ${isError ? "error" : "success"}`;
}

document.getElementById("start-btn").addEventListener("click", async () => {
  const input = document.getElementById("display-name");
  const err = document.getElementById("join-error");
  const code = document.getElementById("join-code").value.trim();
  displayName = input.value.trim();
  if (!code || !displayName) {
    err.style.display = "block";
    err.textContent = "Enter the quiz code and your display name.";
    return;
  }
  joinCode = code;

  const startBtn = document.getElementById("start-btn");
  startBtn.disabled = true;
  startBtn.textContent = "Requesting camera…";

  try {
    await startCamera();
    showCameraToast("Camera enabled — you're ready to answer.", false);
    socket.emit("join_quiz", { code, name: displayName });
    const landmarker = await loadLandmarker();
    document.getElementById("join-form").style.display = "none";
    document.getElementById("quiz-view").style.display = "block";
    document.querySelector("main.card").classList.add("quiz-active");
    lastHandSeenAt = performance.now();
    await refreshQuestion();
    requestAnimationFrame(() => track(landmarker));
  } catch (e) {
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    startBtn.disabled = false;
    startBtn.textContent = "Enable camera & join";
    err.style.display = "block";
    err.textContent =
      e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access and try again."
        : `Could not start: ${e.message}`;
    showCameraToast("Camera could not be enabled.", true);
  }
});

document.getElementById("ready-btn").addEventListener("click", (event) => {
  const button = event.currentTarget;
  socket.emit("participant_ready");
  button.disabled = true;
  button.textContent = "Ready!";
  statusEl.textContent = "You're ready. Waiting for the host to start.";
});

refreshQuestion();
