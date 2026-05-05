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
        let generated = "";
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });

            try {
                const responseJson = JSON.parse(chunk);
                const nextToken = responseJson.answer_token || "";
                yield nextToken;
                generated += nextToken;
            } catch (e) {
                console.error("Chunk was not valid JSON", e);
            }
        }
    } catch (error) {
        console.log("An error occured: ", error)
    }
}