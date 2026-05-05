import { chatHistory, appendMessage } from './messages.js';
import { generateResponse } from './omnichat.js';

const sendButton = document.getElementById('send-button');
const inputField = document.getElementById('input-field');

sendButton.addEventListener('click', async () => {
    const userInput = inputField.value;
    if (userInput !== '') {
        inputField.value = '';
        appendMessage("user", userInput);
        chatHistory.scrollTop = chatHistory.scrollHeight;
        const stream = generateResponse("User", userInput, 'abcdefghijklmnop');
        let generated = "";
        const botMessage = appendMessage("bot", "");
        for await (const token of stream) {
            botMessage.innerHTML = `<span>${generated}</span><span class=new-token>${token}</span>`;
            generated += token;
        }
    }
});