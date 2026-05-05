export const chatHistory = document.getElementById('chat-history');
const spacer = document.getElementById('eoc-spacer');

export function appendMessage(author, content) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');
    const authorDiv = document.createElement('div');
    if (author == 'bot') {
        authorDiv.classList.add('bot');
    } else {
        authorDiv.classList.add('user');
    }
    authorDiv.innerHTML = content;
    messageDiv.appendChild(authorDiv);
    spacer.before(messageDiv);
    return authorDiv;
}