# Omnichat

Omnichat is a locally runnable Large Language Model (LLM) interface featuring Retrieval Augmented Generation (RAG) capabilities, file system access tools, and advanced conversational features. It allows for local execution of sophisticated AI workflows without relying on external services.

## Features

*   **Local LLM Execution:** Runs the core intelligence entirely on the local machine using Ollama.
*   **Retrieval Augmented Generation (RAG):** Enables retrieval of context from a local knowledge base, allowing the model to answer questions based on provided files.
*   **File System Tools:** Implements tools that allow the LLM to read and interact with local files within the knowledge base.
*   **Web Search Integration:** Supports external web searches via integrated tools for up-to-date information.
*   **Markdown Support:** Processes and generates responses using Markdown formatting, including code blocks and lists.
*   **Interactive Interface:** Provides a responsive front-end chat interface with sidebar menus for file management and context navigation.

## Architecture Overview

The system is composed of three main components:

1.  **Frontend (HTML/JS/CSS):** The user interface handles input, displays chat history, manages UI interactions, and streams responses from the backend.
2.  **Backend (Python/FastAPI):** Serves as the API gateway, manages LLM calls, orchestrates tool execution, and performs RAG operations.
3.  **Knowledge Base & Tools:** The core functionality involving vector databases (`ChromaDB`), document processing (PDF, TXT, MD), embedding models (`nomic-embed-text`), and external tool integrations (web search, file reading).

## Installation

### Prerequisites

*   Docker: Required for setting up the backend and Ollama services.
*   Ollama: The local LLM server must be running to provide the model capabilities.

### Setup Steps

1.  **Clone Repository:** Obtain the source code files.
2.  **Build and Run Docker Compose:** Execute `docker-compose` to spin up all necessary services (backend, Ollama, nginx).

    ```bash
    docker-compose up -d
    ```

3.  **Backend Execution:** The container is configured to use the Ollama service running on `http://ollama-service:11434`. The backend will automatically initialize tools and RAG components upon startup.

## Usage

The application is accessed via a web browser navigating to the configured endpoint (e.g., `http://localhost:443` if Nginx is correctly configured).

### Backend Operation

The Python backend utilizes the Ollama service and the defined tools (`search_web`, `read_file`, etc.) to process user queries.

### Chat Interaction

1.  Enter a prompt into the input field.
2.  Press **Send** or **Enter** to initiate the generation process.
3.  The application streams the response, displaying the content and tool outputs in real-time.

## Technical Details

### Backend Setup (`Dockerfile` & `docker-compose.yaml`)

The backend service relies on Python dependencies listed in `requirements.txt`. The Docker setup ensures the necessary environment variables are passed to the container to connect to the Ollama host.

### RAG Pipeline (`vector.py`, `tools.py`)

The Retrieval Augmented Generation pipeline involves:

1.  **Data Ingestion:** Reading supported file formats (TXT, PDF) from the local `knowledge_base` folder.
2.  **Embedding:** Using the `nomic-embed-text` model via Ollama to create vector embeddings for document chunks.
3.  **Storage:** Storing embeddings and document paths in a ChromaDB vector store.
4.  **Query Execution:** When a query is made, it involves web searching (using DuckDuckGo), similarity search against the vector store, reranking results using an LLM prompt, and finally executing file reading tools to retrieve context.

### Frontend Interaction (`omnichat.js`, `app.js`)

The client-side scripts manage the asynchronous communication with the backend `/generate` endpoint. Response streaming is handled by token processing, where markdown content is parsed using `markdown.js` before being rendered in the chat history.

### File Handling Tools (`model_gateway.py`)

The `mcp_server` defines external tools accessible to the LLM:

*   `search_web(query, limit)`: Executes a web search using DuckDuckGo to find current information.
*   `read_file(filepath)`: Reads content from the local knowledge base files (TXT, PDF, etc.).
*   `list_files(path)`: Lists the contents of directories within the knowledge base structure.

These tools are crucial for enabling the LLM to interact with the RAG system and the file storage defined by `tools.py`.