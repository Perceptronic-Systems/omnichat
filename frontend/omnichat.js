import { appendMessage, stopSpinner } from './messages.js';

export const api = "http://127.0.0.1:5014/"

export async function* generateResponse(user, prompt, id) {
    try {
        const response = await fetch(`${api}generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prompt, id })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Server shifted gears into an error: ${response.status}`, errorText);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const status = document.getElementById('status');
        while (true) {
            const {done, value} = await reader.read();
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
                        if (responseJson.status === "finished") {
                            break;
                        }

                        const nextToken = responseJson.answer_token || "";
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