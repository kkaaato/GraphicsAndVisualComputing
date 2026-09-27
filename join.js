const socket = io();

const COLORS = { A: "#ff6b57", B: "#2fb86e", C: "#ffc34b", D: "#8c6bff" };
const HOLD_MS = 1200;
const SEND_MS = 150;          // ~7 fps stream to the server
const FRAME_W = 640;
const FRAME_H = 480;

let displayName = null;
let currentQuestion = null;
let lockedAnswer = null;
let pointing = null;
let progress = 0;

const video = document.createElement("video");
video.autoplay = true;
video.muted = true;
video.playsInline = true;

const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

// offscreen canvas used only to build the frames we send to the server
const capture = document.createElement("canvas");
capture.width = FRAME_W;
capture.height = FRAME_H;
const captureCtx = capture.getContext("2d");

// latest annotated frame produced by the server's OpenCV pipeline
const annotated = new Image();

// ---------------------------------------------------------------- question state
async function refreshQuestion() {
  const r = await fetch("/api/question");
  if (r.status === 204) return;
  currentQuestion = await r.json();
  lockedAnswer = null;
  pointing = null;
  progress = 0;
  document.getElementById("question").textContent = currentQuestion.question;
}

socket.on("question_update", refreshQuestion);

// results coming back from the server-side OpenCV pipeline
socket.on("annotated_frame", (msg) => { annotated.src = msg.frame; });

socket.on("gesture_state", (s) => {
  pointing = s.locked ? null : s.pointing;
  progress = s.progress;
  if (s.locked) lockedAnswer = s.locked;
  const parts = [];
  if (s.choice) parts.push(`pointing: ${s.choice}`);
  if (s.confirmed) parts.push("thumbs-up detected");
  statusEl.textContent = parts.length
    ? `Server sees: ${parts.join(" + ")}`
    : "Show 1–4 fingers to pick A–D, thumbs-up on your other hand to confirm. Hold both for 1.2s.";
});

// ---------------------------------------------------------------- camera loop
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: FRAME_W, height: FRAME_H },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
}

function sendFrame() {
  if (video.readyState >= 2) {
    captureCtx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
    socket.emit("video_frame", {
      frame: capture.toDataURL("image/jpeg", 0.6),
      name: displayName,
    });
  }
}

function draw(now) {
  const w = canvas.width;
  const h = canvas.height;

  // prefer the server's annotated frame; fall back to raw video
  if (annotated.complete && annotated.naturalWidth > 0) {
    ctx.drawImage(annotated, 0, 0, w, h);
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }

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

  letters.forEach((letter, i) => {
    const y = y0 + i * (boxH + gap);
    ctx.fillStyle = COLORS[letter];
    ctx.fillRect(14, y, w - 28, boxH);

    if (lockedAnswer === letter) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.strokeRect(14, y, w - 28, boxH);
    } else if (pointing === letter) {
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

  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- join flow
document.getElementById("start-btn").addEventListener("click", async () => {
  const input = document.getElementById("display-name");
  const err = document.getElementById("join-error");
  displayName = input.value.trim();
  if (!displayName) return;

  try {
    await startCamera();
    document.getElementById("join-form").style.display = "none";
    document.getElementById("quiz-view").style.display = "block";
    await refreshQuestion();
    setInterval(sendFrame, SEND_MS);
    requestAnimationFrame(draw);
  } catch (e) {
    err.style.display = "block";
    err.textContent =
      e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access and try again."
        : `Could not start: ${e.message}`;
  }
});

refreshQuestion();
