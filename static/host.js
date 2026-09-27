const socket = io();

document.getElementById("next-btn").addEventListener("click", () => {
  socket.emit("next_question");
});

socket.on("connect", () => {
  socket.emit("load_quiz", { quiz_id: window.QUIZ_ID });
});

function renderHost(data) {
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

function refresh() {
  fetch("/api/host_question").then(r => r.json()).then(renderHost);
}

refresh();
socket.on("question_update", refresh);
socket.on("answer_locked", refresh);
