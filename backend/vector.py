import os
os.environ["CHROMA_TELEMETRY_ENABLED"] = "FALSE"
from langchain_ollama import OllamaEmbeddings
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.prompts import PromptTemplate
from langchain_ollama import OllamaLLM
from chromadb.config import Settings
from pypdf import PdfReader
import asyncio
import random
import re
import time

client_settings = Settings(
    anonymized_telemetry=False
)

root_folder = "knowledge_base"
embeddings = OllamaEmbeddings(model="nomic-embed-text")
rerank_model = OllamaLLM(model="qwen3-vl:8b-instruct")
db_location = "knowledge_base/chroma_lanchain_db"

# Check if an update is required
add_documents = not os.path.exists(db_location)

# Define how chunks are split
splitter = RecursiveCharacterTextSplitter(
    chunk_size=1500,
    chunk_overlap=300,
    length_function=len
    )

# Get text chunks from file
def read_file(path):
    content_items = []
    content = ""
    if path.endswith(".txt"):
        with open(path, 'r', encoding='utf-8') as file:
            content = file.read()
    elif path.endswith(".pdf"):
        with open(path, 'rb') as file:
            reader = PdfReader(file)
            content = ""
            for page in reader.pages:
                content = content + "\n" + page.extract_text()
    if content != "":
        content_items = splitter.split_text(content)
    else:
        content_items = []
    return content_items

# Update the documents
vector_store = Chroma(
    client_settings=client_settings,
    collection_name="knowledge_base",
    persist_directory=db_location,
    embedding_function=embeddings
)
if add_documents:
    i = 0
    documents = []
    ids = []
    for category in os.listdir(f"{root_folder}/read_only"):
        for file in os.listdir(f"{root_folder}/read_only/{category}"):
            path = f"{root_folder}/read_only/{category}/{file}"
            if (items:=read_file(path)) != []:
                for item in items:
                    document = Document(
                        page_content=f"({file})\n{item}\n__________",
                        metadata={"source": file, "category": category},
                        id=str(i)
                    )
                    ids.append(str(i))
                    documents.append(document)
                    i += 1
    vector_store.add_documents(documents=documents, ids=ids)

retriever = vector_store.as_retriever(search_kwargs={"k": 4})
    
import requests
from bs4 import BeautifulSoup

async def urls_to_markdown(urls):
    markdown_results = {}
    for url in urls:
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                soup = BeautifulSoup(response.text, 'html.parser')
                # Extract only meaningful tags
                markdown = ""
                for tag in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'pre']):
                    if tag.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
                        markdown += f"#{tag.name[1]} {tag.get_text().strip()}\n\n"
                    elif tag.name == 'pre':
                        markdown += "```\n" + tag.get_text().strip() + "\n```\n"
                    elif tag.name == 'p':
                        markdown += f"{tag.get_text().strip()}\n\n"
                    else:
                        # Handle lists (ul/ol)
                        if tag.name in ['ul', 'ol']:
                            markdown += f"{tag.name}:\n"
                            for li in tag.find_all('li'):
                                markdown += f" - {li.get_text().strip()}\n"
                            markdown += "\n"
                markdown_results[url] = markdown.strip()
            else:
                markdown_results[url] = None
        except Exception as e:
            print(f"Error crawling {url}: {e}")
            markdown_results[url] = None
    return markdown_results


def rerank_documents(query, documents, llm, limit=5):
    if len(documents) < limit:
        limit = len(documents)
    example = [2, 0, 1]
    remaining_indices = list(set(range(limit)) - set(example))
    random.shuffle(remaining_indices)
    example.extend(remaining_indices)

    prompt_template = PromptTemplate.from_template("""
Given the query and limit: "{query}", top_n={top_n}

Rank the following documents based on the relevance of their content to the query. Return a list of document indices (0-based) with the length of top_n, in descending order of relevance.

Documents:
{docs}

Return the ranked indices only, e.g., {example}
""")

    # Convert documents to plain text
    docs_text = "\n\n".join(
        [f"{i}. {doc.page_content}" for i, doc in enumerate(documents)]
    )

    prompt = prompt_template.format(query=query, docs=docs_text, top_n=limit, example=example)

    ranked_indices_str = llm.invoke(prompt, think=False)

    try:
        ranked_indices = [int(indice) for indice in re.findall(r'\d+', ranked_indices_str)]
        if len(ranked_indices) > limit:
            ranked_indices = ranked_indices[:limit]
        return [documents[i] for i in ranked_indices]
    except Exception as e:
        print("Failed to parse LLM output:", ranked_indices_str)
        print(e)
        return documents[:limit]

def query_pages(urls, query, limit):
    timer = time.time()
    page_results = asyncio.run(urls_to_markdown(urls))
    print(f"   markdownify time: {time.time() - timer}")

    timer = time.time()
    page_vectors = Chroma(
        client_settings=Settings(anonymized_telemetry=False),
        embedding_function=embeddings
    )
    print(f"   page-embedding time: {time.time() - timer}")

    timer = time.time()
    paragraphs = []
    i = 0
    for url, markdown in page_results.items():
        chunks = [chunk for chunk in splitter.split_text(markdown) if len(chunk) > 300]
        for chunk in chunks:
            paragraphs.append(Document(page_content=f"# Result from source: {url}\n{chunk}", id=str(i)))
            i += 1
    page_vectors.add_documents(documents=paragraphs)
    ranked = page_vectors.similarity_search(query, k=20)
    print(f"   page-split and similarity search: {time.time() - timer}")
    timer = time.time()
    reranked = rerank_documents(query, ranked, rerank_model, limit=limit)
    response = [doc.page_content for doc in reranked]
    print(f"   snippet re-rank time: {time.time() - timer}")
    del page_vectors
    return response