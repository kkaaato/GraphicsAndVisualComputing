const socket = io();
let questionData = null;
let quizStarted = false;
let questionAdvanced = false;
let generatedCode = null;
let participants = new Map();
let participantPage = 0;
const PARTICIPANTS_PER_PAGE = 25;

const codeInput = document.getElementById("join-code");
const startButton = document.getElementById("start-btn");

function createRandomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function renderParticipants() {
  const entries = [...participants.entries()];
  const pageCount = Math.max(1, Math.ceil(entries.length / PARTICIPANTS_PER_PAGE));
  participantPage = Math.min(participantPage, pageCount - 1);
  const grid = document.getElementById("participant-grid");
  grid.replaceChildren();
  entries.slice(participantPage * PARTICIPANTS_PER_PAGE,
    (participantPage + 1) * PARTICIPANTS_PER_PAGE).forEach(([sid, participant]) => {
    const tile = document.createElement("article");
    tile.className = "participant-tile";
    const image = document.createElement("img");
    image.alt = `Live camera preview for ${participant.name}`;
    image.src = participant.frame || "";
    image.hidden = !participant.frame;
    const waiting = document.createElement("div");
    waiting.className = "camera-waiting";
    waiting.textContent = participant.online === false ? "Disconnected" : "Waiting for camera";
    waiting.hidden = Boolean(participant.frame) && participant.online !== false;
    const name = document.createElement("p");
    name.textContent = participant.ready ? `${participant.name} · Ready` : participant.name;
    tile.dataset.sid = sid;
    tile.append(image, waiting, name);
    grid.appendChild(tile);
  });
  document.getElementById("participant-count").textContent = entries.length;
  document.getElementById("page-label").textContent = `Page ${participantPage + 1} of ${pageCount}`;
  document.getElementById("previous-page").disabled = participantPage === 0;
  document.getElementById("next-page").disabled = participantPage >= pageCount - 1;
}

document.getElementById("previous-page").addEventListener("click", () => {
  participantPage -= 1;
  renderParticipants();
});
document.getElementById("next-page").addEventListener("click", () => {
  participantPage += 1;
  renderParticipants();
});

document.getElementById("generate-link-btn").addEventListener("click", () => {
  const customCode = codeInput.value.trim();
  if (customCode && !/^[a-z0-9]{1,12}$/i.test(customCode)) {
    codeInput.setCustomValidity("Use up to 12 letters or numbers.");
    codeInput.reportValidity();
    return;
  }
  codeInput.setCustomValidity("");
  generatedCode = (customCode || createRandomCode()).toUpperCase();
  codeInput.value = generatedCode;
  document.getElementById("generated-code").textContent = generatedCode;
  document.getElementById("join-link").value = `${window.location.origin}/join?code=${encodeURIComponent(generatedCode)}`;
  document.getElementById("share-link-area").hidden = false;
  startButton.disabled = false;
  socket.emit("prepare_quiz", { quiz_id: window.QUIZ_ID, code: generatedCode });
});

document.getElementById("copy-link-btn").addEventListener("click", async () => {
  const copyButton = document.getElementById("copy-link-btn");
  try {
    await navigator.clipboard.writeText(document.getElementById("join-link").value);
    copyButton.textContent = "Copied";
  } catch {
    const link = document.getElementById("join-link");
    link.select();
    document.execCommand("copy");
    copyButton.textContent = "Copied";
  }
});

codeInput.addEventListener("input", () => {
  if (!generatedCode || codeInput.value.trim().toUpperCase() === generatedCode) return;
  generatedCode = null;
  startButton.disabled = true;
  document.getElementById("share-link-area").hidden = true;
});

document.getElementById("start-btn").addEventListener("click", () => {
  if (!generatedCode) return;
  socket.emit("start_quiz", { quiz_id: window.QUIZ_ID });
  quizStarted = true;
  document.getElementById("start-btn").style.display = "none";
});

function renderHost(data) {
  questionData = data;
  questionAdvanced = false;
  document.getElementById("q-num").textContent = data.index + 1;
  document.getElementById("q-total").textContent = data.total;
  document.getElementById("question").textContent = data.question;

  const box = document.getElementById("choices");
  box.innerHTML = "";
  Object.entries(data.choices).forEach(([letter, text]) => {
    const row = document.createElement("div");
    row.className = "quiz-row";
    row.innerHTML = `<span><strong>${letter}.</strong> ${text}</span>` +
                     (letter === data.answer ? "<span>✓ correct</span>" : "");
    box.appendChild(row);
  });

  const statusEl = document.getElementById("status");
  if (data.locked_answer) {
    const correct = data.is_correct;
    statusEl.textContent = `Locked answer: ${data.locked_answer} — ${correct ? "Correct!" : "Incorrect"}`;
    statusEl.className = "status " + (correct ? "correct" : "wrong");
  } else {
    statusEl.textContent = `Answers received: ${data.answers_received || 0}`;
    statusEl.className = "status";
  }
}

function updateTimer() {
  const timer = document.getElementById("timer");
  if (!questionData || !questionData.started_at) return;
  const remaining = Math.max(0, Math.ceil(
    questionData.time_limit - (Date.now() / 1000 - questionData.started_at)
  ));
  const lastQuestion = questionData.index + 1 >= questionData.total;
  timer.textContent = remaining
    ? `Time remaining: ${remaining}s`
    : (lastQuestion ? "Quiz complete" : "Time is up");
  timer.className = remaining <= 5 ? "status wrong" : "status";
  if (!remaining && !questionAdvanced) {
    questionAdvanced = true;
    socket.emit("next_question");
  }
}

function refresh() {
  if (!quizStarted) return;
  fetch("/api/host_question").then(r => r.json()).then((data) => {
    if (data.question) renderHost(data);
  });
}

socket.on("question_update", refresh);
socket.on("answer_locked", refresh);
socket.on("participant_joined", ({ sid, name }) => {
  participants.set(sid, { name, frame: null, online: true, ready: false });
  renderParticipants();
});
socket.on("participant_ready", ({ sid }) => {
  const participant = participants.get(sid);
  if (participant) participant.ready = true;
  renderParticipants();
});
socket.on("participant_left", ({ sid }) => {
  const participant = participants.get(sid);
  if (participant) participant.online = false;
  renderParticipants();
});
socket.on("participant_camera", ({ sid, name, frame }) => {
  const participant = participants.get(sid) || { name, online: true };
  participant.name = name;
  participant.frame = frame;
  participant.online = true;
  participants.set(sid, participant);
  const tile = document.querySelector(`[data-sid="${CSS.escape(sid)}"]`);
  if (tile) {
    const image = tile.querySelector("img");
    image.src = frame;
    image.hidden = false;
    tile.querySelector(".camera-waiting").hidden = true;
  } else {
    renderParticipants();
  }
});
socket.on("quiz_ended", () => {
  document.getElementById("timer").textContent = "Quiz complete";
  window.location.assign(window.SCOREBOARD_URL);
});
setInterval(updateTimer, 250);
