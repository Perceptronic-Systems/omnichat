import { chatHistory, appendMessage } from './messages.js';
import { generateResponse } from './omnichat.js';
import { parseMarkdown } from "./markdown.js";

const fileInput = document.getElementById('add-media');

const id = Math.floor(Math.random() * 100000000);;

const sendButton = document.getElementById('send-button');
const inputField = document.getElementById('input-field');
const navButton = document.getElementById('menu-toggle');
const navMenu = document.getElementById('nav-menu');

if (window.innerWidth > 812) {
    navMenu.style.visibility = 'visible';
    navMenu.style.opacity = 1;
}
window.addEventListener('resize', e => {
    if (window.innerWidth > 812) {
        navMenu.style.visibility = 'visible';
        navMenu.style.opacity = 1;
    }
})

navButton.addEventListener('click', e => {
    if (navMenu.style.visibility === 'hidden') {
        navMenu.style.visibility = 'visible';
        navMenu.style.opacity = 1;
    } else {
        navMenu.style.visibility = 'hidden';
        navMenu.style.opacity = 0;
        const existing = Array.from(document.getElementsByClassName('side-popup'));
        if (existing.length > 0) existing.forEach(e => e.remove());
    }
});

sendButton.addEventListener('click', async () => {
    await sendMessage();
});

async function sendMessage() {
    const userInput = inputField.value;
    const files = fileInput.files;
    if (userInput !== '') {
        inputField.value = '';
        appendMessage("user", parseMarkdown(userInput));
        if (files.length > 0) {
            appendMessage("user", `*Attached ${files.length} file(s)*`);
        }
        chatHistory.scrollTop = chatHistory.scrollHeight;
        const stream = generateResponse("User", userInput, id, files);
        fileInput.value = '';
        let generated = "";
        const botMessage = appendMessage("bot", "");
        for await (const token of stream) {
            const markdownContent = parseMarkdown(generated);
            document.querySelectorAll('.new-token').forEach(t => t.remove()); // Deletes the previous "new token" if it exists since it's now part of the text
            const newToken = document.createElement('span');
            newToken.classList.add('new-token');
            newToken.textContent = token;
            botMessage.innerHTML = markdownContent;
            let parentLine = botMessage.lastElementChild;
            if (parentLine) {
                const tagName = parentLine.tagName.toLowerCase();
                if (tagName === 'ul' || tagName === 'ol') {
                    parentLine = parentLine.lastElementChild;
                } else if (tagName === 'pre') {
                    parentLine = parentLine.querySelector('code');
                }
                parentLine.appendChild(newToken);
            }
            generated += token;
        }
    }
}

inputField.addEventListener('keydown', async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        await sendMessage();
    }
});