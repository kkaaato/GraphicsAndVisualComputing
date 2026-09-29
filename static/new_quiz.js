const questionList = document.getElementById("question-list");
const addQuestionButton = document.getElementById("add-question");
const form = document.querySelector("form");
const questionsField = document.getElementById("questions");
let nextQuestionId = 1;

function renumberAnswers(answerList, questionId) {
  [...answerList.children].forEach((row, index) => {
    const letter = String.fromCharCode(65 + index);
    row.querySelector(".answer-letter").textContent = letter;
    row.querySelector(".answer-text").placeholder = `Answer ${letter}`;
    const correct = row.querySelector("input[type=radio]");
    correct.name = `correct-${questionId}`;
    correct.value = letter;
  });
}

function addAnswer(answerList, questionId, answerText = "", isCorrect = false) {
  if (answerList.children.length >= 4) return;

  const answerNumber = answerList.children.length;
  const letter = String.fromCharCode(65 + answerNumber);
  const row = document.createElement("div");
  row.className = "answer-row";
  row.innerHTML = `
    <span class="answer-letter">${letter}</span>
    <input type="text" class="answer-text" placeholder="Answer ${letter}" value="${answerText}">
    <label class="correct-option">
      <input type="radio" name="correct-${questionId}" value="${letter}"${isCorrect || (!answerText && answerNumber === 0) ? " checked" : ""}>
      Correct
    </label>
    <button type="button" class="remove-answer" title="Remove answer">Remove</button>
  `;
  row.querySelector(".remove-answer").addEventListener("click", () => {
    if (answerList.children.length <= 2) return;
    const wasCorrect = row.querySelector("input[type=radio]").checked;
    row.remove();
    renumberAnswers(answerList, questionId);
    if (wasCorrect) answerList.querySelector("input[type=radio]").checked = true;
  });
  answerList.appendChild(row);
}

function addQuestion(initial = null) {
  const questionId = nextQuestionId++;
  const questionNumber = questionList.children.length + 1;
  const questionText = initial ? (initial.question || initial.question_text) : "";
  const choices = initial ? (initial.choices || {
    A: initial.choice_a,
    B: initial.choice_b,
    C: initial.choice_c,
    D: initial.choice_d,
  }) : null;
  const card = document.createElement("details");
  card.className = "question-builder";
  card.open = initial ? questionNumber === 1 : true;
  if (!initial) [...questionList.children].forEach((c) => { c.open = false; });
  card.innerHTML = `
    <summary class="question-heading">
      <span class="question-label">
        <span class="question-title">Question ${questionNumber}</span>
        <span class="question-preview"></span>
      </span>
      <button type="button" class="remove-question">Remove question</button>
    </summary>
    <div class="question-body">
      <input type="text" class="question-text" placeholder="Type your question" value="${questionText}" required>
      <label>Time limit (seconds)</label>
      <input type="number" class="time-limit" min="5" max="600" value="${initial ? initial.time_limit : 30}" required>
      <div class="answer-list"></div>
      <button type="button" class="add-answer">+ Add answer</button>
    </div>
  `;
  const questionInput = card.querySelector(".question-text");
  const preview = card.querySelector(".question-preview");
  const syncPreview = () => {
    const t = questionInput.value.trim();
    preview.textContent = t ? `— ${t}` : "";
  };
  questionInput.addEventListener("input", syncPreview);
  syncPreview();

  const answerList = card.querySelector(".answer-list");
  if (initial) {
    Object.entries(choices).filter(([, text]) => text).forEach(([letter, text]) => {
      addAnswer(answerList, questionId, text, letter === initial.correct_letter || letter === initial.answer);
    });
  } else {
    addAnswer(answerList, questionId);
    addAnswer(answerList, questionId);
  }
  card.querySelector(".add-answer").addEventListener("click", () => {
    addAnswer(answerList, questionId);
  });
    card.querySelector(".remove-question").addEventListener("click", (event) => {
    event.preventDefault();   // stop the click from toggling the dropdown
    if (questionList.children.length <= 1) return;
    card.remove();
    [...questionList.children].forEach((question, index) => {
      question.querySelector(".question-title").textContent = `Question ${index + 1}`;
    });
  });
  questionList.appendChild(card);
}

function serializeQuestions() {
  const lines = [];
  for (const card of questionList.children) {
    const question = card.querySelector(".question-text").value.trim();
    const timeLimit = card.querySelector(".time-limit").value;
    const answers = [...card.querySelectorAll(".answer-row")];
    const correct = card.querySelector("input[type=radio]:checked");
    const texts = answers.map((row) => row.querySelector(".answer-text").value.trim());

    if (!question || !timeLimit || texts.length < 2 || texts.some((text) => !text) || !correct) {
      return null;
    }
    lines.push([question, ...texts, correct.value, timeLimit].join("|"));
  }
  return lines.join("\n");
}

addQuestionButton.addEventListener("click", () => addQuestion());
const editData = JSON.parse(document.getElementById("edit-quiz-data").dataset.quiz);
if (editData && editData.length) {
  editData.forEach((q) => addQuestion(q));
} else {
  addQuestion();
}

form.addEventListener("submit", (event) => {
  const serialized = serializeQuestions();
  if (!serialized) {
    event.preventDefault();
    window.alert("Add a question with at least two answers, and choose the correct answer.");
    return;
  }
  questionsField.value = serialized;
});
// if a hidden required field fails validation, open its dropdown so the error is visible
form.addEventListener("invalid", (e) => {
  const d = e.target.closest("details");
  if (d) d.open = true;
}, true);