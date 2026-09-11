'use strict';
const form = document.querySelector('#question-form');
const input = document.querySelector('#question');
const invitation = document.querySelector('#invitation');
const messages = document.querySelector('#messages');
const send = document.querySelector('#send');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const serviceUnavailable = !window.BETANCOURT_CONFIG?.apiBase && location.hostname.endsWith('github.io');
if (serviceUnavailable) {
  status.textContent = 'Публичный сервер ещё не подключён. Консультации пока недоступны.';
  send.disabled = true;
  invitation.disabled = true;
}
let activeRequest;
let generation = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

input.addEventListener('input', () => { document.querySelector('#count').textContent = `${input.value.length} / 2000`; });
document.querySelector('#forget').addEventListener('click', () => {
  generation++;
  activeRequest?.abort();
  activeRequest = undefined;
  invitation.value = '';
  input.value = '';
  messages.replaceChildren(element('p', 'Задайте новый полный вопрос.', 'empty'));
  status.textContent = serviceUnavailable ? 'Публичный сервер ещё не подключён. Консультации пока недоступны.' : '';
  error.hidden = true;
  send.disabled = serviceUnavailable;
  input.dispatchEvent(new Event('input'));
  invitation.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (activeRequest || serviceUnavailable) return;
  const token = invitation.value.trim();
  const question = input.value.trim();
  error.hidden = true;
  if (!token) { error.textContent = 'Введите код приглашения.'; error.hidden = false; invitation.focus(); return; }
  if (!question || question.length > 2000) return;
  const configured = window.BETANCOURT_CONFIG?.apiBase;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!configured && location.hostname.endsWith('github.io')) { error.textContent = 'Адрес сервиса ещё не настроен.'; error.hidden = false; return; }
  const endpoint = new URL(`${(configured || '/betancourt').replace(/\/$/, '')}/api/chat`, location.origin);
  if (endpoint.protocol !== 'https:' && !(local && endpoint.origin === location.origin)) { error.textContent = 'Для подключения требуется HTTPS.'; error.hidden = false; return; }
  const controller = new AbortController();
  activeRequest = controller;
  const ownGeneration = generation;
  const timeout = setTimeout(() => controller.abort(), 65000);
  send.disabled = true;
  status.textContent = 'Ищем фрагменты и готовим ответ…';
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: question }), signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Сервис временно недоступен.');
    if (typeof body.answer !== 'string' || !Array.isArray(body.sources)) throw new Error('Сервис вернул некорректный ответ.');
    if (ownGeneration !== generation) return;
    messages.querySelector('.empty')?.remove();
    const article = element('article', undefined, 'exchange');
    article.append(element('p', 'Ваш вопрос', 'speaker'), element('p', question, 'question-text'), element('p', 'Консультант', 'speaker'), element('p', body.answer, 'answer'));
    const sources = element('details', undefined, 'sources');
    sources.append(element('summary', `Найденные фрагменты · ${body.sources.length}`));
    for (const source of body.sources) {
      const item = element('section');
      item.append(element('h3', source.section), element('p', source.excerpt));
      sources.append(item);
    }
    article.append(sources);
    messages.append(article);
    while (messages.children.length > 20) messages.firstElementChild.remove();
    input.value = '';
    input.dispatchEvent(new Event('input'));
    status.textContent = 'Ответ готов. Следующий вопрос задайте полностью.';
    article.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  } catch (failure) {
    if (ownGeneration !== generation) return;
    status.textContent = '';
    error.textContent = failure.name === 'AbortError' ? 'Время ожидания истекло. Попробуйте позже.' : failure.message;
    error.hidden = false;
  } finally {
    clearTimeout(timeout);
    if (ownGeneration === generation) { activeRequest = undefined; send.disabled = false; }
  }
});
