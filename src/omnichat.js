import { appendMessage, stopSpinner } from './messages.js';

export function clearStoredApi() {
    localStorage.removeItem('omnichat_api_url');
}

export function initializeApi() {
    let storedApi = localStorage.getItem('omnichat_api_url');
    
    if (!storedApi) {
        // Fallback default value to show in the prompt box
        const defaultApi = `http://127.0.0.1:5014/api/`;
        
        let userInput = prompt("Please enter your API Base URL:", defaultApi);
        
        // If user cancels or leaves it empty, fallback to default
        if (!userInput || userInput.trim() === "") {
            storedApi = defaultApi;
        } else {
            storedApi = userInput.trim();
        }
        
        // Ensure it ends with a trailing slash to prevent URL concatenation bugs
        if (!storedApi.endsWith('/')) {
            storedApi += '/';
        }
        
        // Save it for the next visit
        localStorage.setItem('omnichat_api_url', storedApi);
    }
    
    return storedApi;
}

export let api = initializeApi();

export function setApi(newApi) { api = newApi };
console.log(`API: ${api}`);

export async function* generateResponse(user, prompt, id, files = []) {
    const status = document.getElementById('status');
    try {
        const formData = new FormData();
        formData.append('id', id);
        formData.append('prompt', prompt || '');

        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                formData.append('files', files[i]);
            }
        } else {
            formData.append('files', new Blob([]), ''); 
        }

        const response = await fetch(`${api}generate`, {
            method: 'POST',
            body: formData // Explicitly NO Content-Type header! Let the browser handle it.
        });

        if (!response.ok) throw new Error(`HTTP error occured, status : ${response.status}`)

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split('\n\n');

            buffer = parts.pop();

            for (const part of parts) {
                const line = part.trim();
                if (!line) continue;
                if (line.startsWith('data:')) {
                    const jsonString = line.replace(/^data:\s*/, "");

                    try {
                        const responseJson = JSON.parse(jsonString);
                        if (responseJson.isDone === true || responseJson.status === "Idle") {
                            break;
                        }

                        const nextToken = responseJson.token || "";
                        if (status) {
                            status.textContent = responseJson.status || 'Retrieving Data';
                        }
                        yield nextToken;
                    } catch (e) {
                        console.error("Chunk was not valid JSON", e);
                    }
                }
            }
        }
        stopSpinner();
        if (status) status.parentElement.remove();
    } catch (error) {
        console.log("An error occured: ", error)
    }
}