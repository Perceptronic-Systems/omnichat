import { api, initializeApi, clearStoredApi, setApi } from './omnichat.js';

export function resetApi() {
    clearStoredApi();
    setApi(initializeApi());
}

export function downloadChat() {
    console.log('Development under progress, coming soon');
}

export function uploadChat() {
    console.log('Development under progress, coming soon');
}

const header = document.getElementById('header');

let elements = {
    file: {dir: true, contents: ['download_chat', 'upload_chat']},
    edit: {dir: true, contents: ["change_API_link"]},
    view: {dir: true, contents: []},
    help: {dir: true, contents: []},
    change_API_link: {dir: false, action: resetApi},
    download_chat: {dir: false, action: downloadChat},
    upload_chat: {dir: false, action: uploadChat}
};

export function hideAll() {
    const existing = Array.from(document.getElementsByClassName('side-popup'));
    if (existing.length > 0) existing.forEach(e => e.remove());
    const navMenu = document.getElementById('nav-menu');
    if (window.innerWidth <= 812) {
        navMenu.style.visibility = 'hidden';
        navMenu.style.opacity = 0;
    }
}

document.addEventListener('keydown', e => {
    switch (e.key.toLowerCase()) {
        case "escape":
            e.preventDefault();
            hideAll();
            break;
    }
})

export function generateTable(domElement) {
    const name = "contents_" + domElement.name;
    const existing = Array.from(document.getElementsByClassName('side-popup'));
    if (existing.length > 0) existing.forEach(e => {
        e.remove()
        console.log('removed popup')
    });
    const item = elements[domElement.name]
    if (item.dir) {
        const container = document.createElement('div');
        container.classList.add('side-popup');
        container.name = name;
        container.style.position = 'absolute'; 
        item.contents.forEach(element => {
            const e = document.createElement('button');
            e.textContent = element.replace('_', ' ');
            e.classList.add("task-button");
            e.name = element
            container.appendChild(e);
        });
        const rect = domElement.getBoundingClientRect();
        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;
        if (window.innerWidth > 812) {
            container.style.left = `${rect.left + scrollX}px`;
            container.style.top = `${rect.bottom + scrollY}px`;
        } else {
            container.style.left = `${rect.right + scrollX}px`;
            container.style.top = `${rect.top + scrollY}px`;
        }
        header.appendChild(container);
    } else {
        item.action();
        hideAll();
    }
}

document.addEventListener('click', (evt) => {
    if (!event.target.classList.contains('task-button')) return;
    generateTable(event.target);
});