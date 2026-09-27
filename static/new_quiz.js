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
  const card = document.createElement("section");
  card.className = "question-builder";
  card.innerHTML = `
    <div class="question-heading">
      <h2>Question ${questionNumber}</h2>
      <button type="button" class="remove-question">Remove question</button>
    </div>
    <input type="text" class="question-text" placeholder="Type your question" value="${questionText}" required>
    <label>Time limit (seconds)</label>
    <input type="number" class="time-limit" min="5" max="600" value="${initial ? initial.time_limit : 30}" required>
    <div class="answer-list"></div>
    <button type="button" class="add-answer">+ Add answer</button>
  `;

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
  card.querySelector(".remove-question").addEventListener("click", () => {
    if (questionList.children.length <= 1) return;
    card.remove();
    [...questionList.children].forEach((question, index) => {
      question.querySelector("h2").textContent = `Question ${index + 1}`;
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

addQuestionButton.addEventListener("click", addQuestion);
if (window.EDIT_QUIZ && window.EDIT_QUIZ.length) {
  window.EDIT_QUIZ.forEach(addQuestion);
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