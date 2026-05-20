function parseInline(text) {
    return text
        // Escape native HTML to prevent XSS injection
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // Bold (**text**)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Italics (*text*)
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Inline Code (`code`)
        .replace(/`(.*?)`/g, '<code>$1</code>');
}

export function parseMarkdown(buffer) {
    let htmlContent = '';
    let inList = false;
    let inCodeBlock = false;

    for (const line of buffer.split('\n')) {
        if (line === undefined || line === null) continue;
        const trimmed = line.trim();

        if (!inCodeBlock) {
            if (trimmed.startsWith('```')) {
                inCodeBlock = true;
                htmlContent += "<pre><code>";
                continue;
            } else if (trimmed.startsWith('* ' || trimmed.startsWith('- '))) {
                if (!inList) {
                    htmlContent += '<ul>';
                    inList = true;
                }
                htmlContent += `<li>${parseInline(trimmed.substring(2))}</li>`;
                continue;
            } else if (trimmed === '') {
                if (inList) {
                    htmlContent += '</ul>';
                    continue;
                }
            }

            if (trimmed.startsWith("# ")) {
                htmlContent += `<h1>${parseInline(trimmed.substring(2))}</h1>`;
            } else if (trimmed.startsWith("## ")) {
                htmlContent += `<h1>${parseInline(trimmed.substring(3))}</h1>`;
            } else if (trimmed.startsWith("### ")) {
                htmlContent += `<h1>${parseInline(trimmed.substring(4))}</h1>`;
            } else if (trimmed.startsWith("#### ")) {
                htmlContent += `<h1>${parseInline(trimmed.substring(5))}</h1>`;
            } else if (trimmed.startsWith('> ')) {
                htmlContent += `<blockquote>${parseInline(trimmed.substring(2))}</blockquote>`;
            } else {
                htmlContent += `<p>${parseInline(trimmed)}</p>`;
            }
        } else {
            if (trimmed.startsWith('```')) {
                inCodeBlock = false;
                htmlContent += "</code></pre>";
            } else if (inCodeBlock) {
                let escapedLine = line
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                    
                htmlContent += escapedLine + '\n';
            }
        }
    }
    if (inList) htmlContent += '</ul>';
    if (inCodeBlock) htmlContent += '</code></pre>'
    return htmlContent
}