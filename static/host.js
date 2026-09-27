const socket = io();
let questionData = null;
let quizStarted = false;

document.getElementById("start-btn").addEventListener("click", () => {
  socket.emit("load_quiz", { quiz_id: window.QUIZ_ID });
  quizStarted = true;
  document.getElementById("start-btn").style.display = "none";
  document.getElementById("next-btn").disabled = false;
});

document.getElementById("next-btn").addEventListener("click", () => {
  if (!quizStarted) return;
  socket.emit("next_question");
});

function renderHost(data) {
  questionData = data;
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
    statusEl.textContent = "Waiting for an answer…";
    statusEl.className = "status";
  }
}

function updateTimer() {
  const timer = document.getElementById("timer");
  if (!questionData || !questionData.started_at) return;
  const remaining = Math.max(0, Math.ceil(
    questionData.time_limit - (Date.now() / 1000 - questionData.started_at)
  ));
  timer.textContent = remaining ? `Time remaining: ${remaining}s` : "Time is up";
  timer.className = remaining <= 5 ? "status wrong" : "status";
}

function refresh() {
  if (!quizStarted) return;
  fetch("/api/host_question").then(r => r.json()).then((data) => {
    if (data.question) renderHost(data);
  });
}

socket.on("question_update", refresh);
socket.on("answer_locked", refresh);
setInterval(updateTimer, 250);
