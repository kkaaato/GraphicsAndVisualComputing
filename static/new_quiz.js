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
    <input type="text" class="answer-text" placeholder="Answer ${letter}">
    <label class="correct-option">
      <input type="radio" name="correct-${questionId}" value="${letter}"${isCorrect || (!answerText && answerNumber === 0) ? " checked" : ""}>
      Correct
    </label>
    <button type="button" class="remove-answer" title="Remove answer">Remove</button>
  `;
  row.querySelector(".answer-text").value = answerText;
  row.querySelector(".remove-answer").addEventListener("click", (event) => {
    event.stopPropagation();
    if (answerList.children.length <= 2) return;
    const wasCorrect = row.querySelector("input[type=radio]").checked;
    row.remove();
    renumberAnswers(answerList, questionId);
    if (wasCorrect) answerList.querySelector("input[type=radio]").checked = true;
  });
  answerList.appendChild(row);
}

function addQuestion(initial = null, startCollapsed = false) {
  const questionId = nextQuestionId++;
  const questionNumber = questionList.children.length + 1;
  const questionText = initial ? (initial.question || initial.question_text || "") : "";
  const choices = initial ? (initial.choices || {
    A: initial.choice_a,
    B: initial.choice_b,
    C: initial.choice_c,
    D: initial.choice_d,
  }) : null;

  const card = document.createElement("section");
  card.className = "question-builder" + (startCollapsed ? " collapsed" : "");
  card.innerHTML = `
    <div class="question-heading">
      <h2><span class="chevron">&#9660;</span> Question ${questionNumber}</h2>
      <button type="button" class="remove-question">Remove question</button>
    </div>
    <div class="question-body">
      <label>Question text</label>
      <input type="text" class="question-text" placeholder="Type your question" required>
      <label>Time limit (seconds)</label>
      <input type="number" class="time-limit" min="5" max="600" value="${initial ? initial.time_limit : 30}" required>
      <div class="answer-list"></div>
      <button type="button" class="add-answer">+ Add answer</button>
    </div>
  `;
  card.querySelector(".question-text").value = questionText;

  // clicking anywhere on the heading toggles collapse, except the remove button
  card.querySelector(".question-heading").addEventListener("click", (event) => {
    if (event.target.closest(".remove-question")) return;
    card.classList.toggle("collapsed");
  });

  const answerList = card.querySelector(".answer-list");
  if (initial) {
    Object.entries(choices).filter(([, text]) => text).forEach(([letter, text]) => {
      addAnswer(answerList, questionId, text, letter === initial.correct_letter || letter === initial.answer);
    });
  } else {
    addAnswer(answerList, questionId);
    addAnswer(answerList, questionId);
  }
  card.querySelector(".add-answer").addEventListener("click", (event) => {
    event.stopPropagation();
    addAnswer(answerList, questionId);
  });
  card.querySelector(".remove-question").addEventListener("click", (event) => {
    event.stopPropagation();
    if (questionList.children.length <= 1) return;
    card.remove();
    [...questionList.children].forEach((question, index) => {
      question.querySelector("h2").innerHTML = `<span class="chevron">&#9660;</span> Question ${index + 1}`;
    });
  });
  questionList.appendChild(card);
}

addQuestionButton.addEventListener("click", () => addQuestion());

if (window.EDIT_QUIZ && window.EDIT_QUIZ.length) {
  window.EDIT_QUIZ.forEach((question, index) => addQuestion(question, index !== 0));
} else {
  addQuestion();
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
      card.classList.remove("collapsed");
      return null;
    }
    lines.push([question, ...texts, correct.value, timeLimit].join("|"));
  }
  return lines.join("\n");
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
