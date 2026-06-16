import { chatHistory, appendMessage } from './messages.js';
import { generateResponse } from './omnichat.js';
import { parseMarkdown } from "./markdown.js";

const fileInput = document.getElementById('add-media');
const previewContainer = document.getElementById('file-preview-container');

let selectedFiles = [];

// Helper function to map file extensions to universal emojis/icons
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
    if (ext === 'pdf') return '📕';
    if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '📄';
    if (['js', 'py', 'html', 'css', 'json'].includes(ext)) return '💻';
    return '📁'; // Default fallback icon
}

// Re-render the visual list of pending attachments
function updateFilePreviews() {
    previewContainer.innerHTML = ''; // Wipe current elements
    
    selectedFiles.forEach((file, index) => {
        const badge = document.createElement('div');
        badge.classList.add('file-preview-badge');
        
        const icon = getFileIcon(file.name);
        
        badge.innerHTML = `
            <span class="file-preview-icon">${icon}</span>
            <span class="file-preview-name" title="${file.name}">${file.name}</span>
            <button class="file-preview-remove" data-index="${index}">×</button>
        `;
        
        previewContainer.appendChild(badge);
    });
}

// Event: User selects files via file browser
fileInput.addEventListener('change', (e) => {
    // Merge newly added items with existing staged files
    const files = Array.from(e.target.files);
    selectedFiles = [...selectedFiles, ...files];
    
    updateFilePreviews();
    fileInput.value = ''; // Reset input element state so change fires on duplicates
});

// Event: User clicks the "X" remove button inside the container
previewContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('file-preview-remove')) {
        const indexToRemove = parseInt(e.target.getAttribute('data-index'));
        selectedFiles.splice(indexToRemove, 1); // Slice out target item
        updateFilePreviews(); // Refresh presentation layer
    }
});

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

    if (userInput !== '' || selectedFiles.length > 0) {
        inputField.value = '';
        
        appendMessage("user", parseMarkdown(userInput));
        
        if (selectedFiles.length > 0) {
            appendMessage("user", `*Attached ${selectedFiles.length} file(s)*`);
        }
        
        chatHistory.scrollTop = chatHistory.scrollHeight;

        // Pass tracked array to the stream generator
        const stream = generateResponse("User", userInput, id, selectedFiles);
        
        // Reset state values cleanly for next prompt context
        selectedFiles = [];
        updateFilePreviews();

        let generated = "";
        const botMessage = appendMessage("bot", "");
        
        for await (const token of stream) {
            const markdownContent = parseMarkdown(generated);
            document.querySelectorAll('.new-token').forEach(t => t.remove());
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

function adjustViewportHeight() {
  if (window.visualViewport) {
    // Set a custom CSS variable on the document root
    const vvHeight = window.visualViewport.height;
    document.documentElement.style.setProperty('--vv-height', `${vvHeight}px`);
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustViewportHeight);
  window.visualViewport.addEventListener('scroll', adjustViewportHeight);
}

adjustViewportHeight();