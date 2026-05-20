export const chatHistory = document.getElementById('chat-history');
const spacer = document.getElementById('eoc-spacer');

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval = null;

export function startSpinner(statusElement) {
    let frameIndex = 0;

    if (spinnerInterval) clearInterval(spinnerInterval);

    spinnerInterval = setInterval(() => {
        statusElement.textContent = spinnerFrames[frameIndex] + '  ' + statusElement.textContent.slice(3);
        frameIndex = (frameIndex + 1) % spinnerFrames.length;
    }, 80);
}

export function stopSpinner() {
    clearInterval(spinnerInterval); 
    spinnerInterval = null;
}

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
    if (author == 'bot') {
        const statusContainer = document.createElement('div');
        statusContainer.classList.add('status-container');
        const spinner = document.createElement('span');
        spinner.classList.add('status');
        spinner.id = 'spinner';
        const status = document.createElement('span');
        status.classList.add('status');
        status.id = 'status';
        status.textContent = 'Connecting';
        statusContainer.appendChild(spinner);
        statusContainer.appendChild(status);
        messageDiv.appendChild(statusContainer);
        startSpinner(spinner);
    }
    spacer.before(messageDiv);
    return authorDiv;
}