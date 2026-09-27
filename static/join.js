const socket = io();

const COLORS = { A: "#ff6b57", B: "#2fb86e", C: "#ffc34b", D: "#8c6bff" };
const HOLD_MS = 1200;
const MP_VERSION = "0.10.14";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let displayName = null;
let currentQuestion = null;
let lockedAnswer = null;
let pointing = null;
let holdStart = null;

const video = document.createElement("video");
video.autoplay = true;
video.muted = true;
video.playsInline = true;

const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------- question state
async function refreshQuestion() {
  const r = await fetch("/api/question");
  if (r.status === 204) return;
  currentQuestion = await r.json();
  lockedAnswer = null;
  pointing = null;
  holdStart = null;
  document.getElementById("question").textContent = currentQuestion.question;
}

socket.on("question_update", refreshQuestion);

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
  const count = states.slice(1).filter(Boolean).length;
  return { 1: "A", 2: "B", 3: "C", 4: "D" }[count] || null;
}

function isThumbsUp(states, lm) {
  return states[0] && !states.slice(1).some(Boolean) && lm[4].y < lm[3].y - 0.02;
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
  return vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.7,
    minHandPresenceConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });
}

function draw(now) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(video, 0, 0, w, h);

  if (!currentQuestion) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "28px sans-serif";
    ctx.fillText("Waiting for the host to start…", 24, 48);
    return;
  }

  const letters = Object.keys(currentQuestion.choices);
  const boxH = Math.round(h * 0.09);
  const gap = 10;
  const y0 = h - (boxH + gap) * letters.length - gap;

  ctx.fillStyle = "rgba(20,20,20,0.85)";
  ctx.fillRect(0, 0, w, 56);
  ctx.fillStyle = "#ffffff";
  ctx.font = "22px sans-serif";
  ctx.fillText(currentQuestion.question.slice(0, 72), 14, 37);

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
    ctx.font = "20px sans-serif";
    ctx.fillText(`${letter}. ${currentQuestion.choices[letter]}`.slice(0, 58), 26, y + boxH / 2 + 7);
  });

  if (lockedAnswer) {
    ctx.fillStyle = "#2fb86e";
    ctx.font = "22px sans-serif";
    ctx.fillText(`Locked in: ${lockedAnswer}`, 16, h - 6);
  }
}

function track(landmarker) {
  const now = performance.now();
  let choice = null;
  let confirmed = false;

  if (video.readyState >= 2) {
    const result = landmarker.detectForVideo(video, now);
    for (const lm of result.landmarks) {
      const states = fingersUp(lm);
      choice = choiceFrom(states) || choice;
      if (isThumbsUp(states, lm)) confirmed = true;
    }
  }

  if (currentQuestion && !lockedAnswer) {
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
  }

  draw(now);
  requestAnimationFrame(() => track(landmarker));
}

// ---------------------------------------------------------------- join flow
document.getElementById("start-btn").addEventListener("click", async () => {
  const input = document.getElementById("display-name");
  const err = document.getElementById("join-error");
  displayName = input.value.trim();
  if (!displayName) return;

  try {
    await startCamera();
    const landmarker = await loadLandmarker();
    document.getElementById("join-form").style.display = "none";
    document.getElementById("quiz-view").style.display = "block";
    await refreshQuestion();
    requestAnimationFrame(() => track(landmarker));
  } catch (e) {
    err.style.display = "block";
    err.textContent =
      e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access and try again."
        : `Could not start: ${e.message}`;
  }
});

refreshQuestion();
